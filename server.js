import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "8mb" }));

// =========================
// CORS
// =========================
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ ENV missing");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// =========================
// HELPERS
// =========================
const safeStr = (x) => (typeof x === "string" ? x : "");

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((m) => ({
      role: m?.role === "assistant" ? "AI" : "User",
      content: safeStr(m?.content).trim(),
    }))
    .filter((m) => m.content);
}

function buildTranscript(history) {
  return normalizeHistory(history)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

function extractCards(text) {
  const START = "@@LSD_JSON_START@@";
  const END = "@@LSD_JSON_END@@";

  const s = text.indexOf(START);
  const e = text.indexOf(END);

  if (s === -1 || e === -1) {
    return { text: text.trim(), cards: [] };
  }

  try {
    const json = JSON.parse(text.slice(s + START.length, e).trim());
    return {
      text: (text.slice(0, s) + text.slice(e + END.length)).trim(),
      cards: Array.isArray(json.cards) ? json.cards : [],
    };
  } catch {
    return { text: text.trim(), cards: [] };
  }
}

async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6 },
      }),
    }
  );

  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || "gemini_error");

  return (
    json?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim() || ""
  );
}

// =========================
// DB
// =========================
async function getUser(tg_id) {
  const { data, error } = await supabase
    .from("lsd_users")
    .select("*")
    .eq("tg_id", tg_id)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: created, error: e2 } = await supabase
    .from("lsd_users")
    .insert({ tg_id, tier: "free" })
    .select("*")
    .single();

  if (e2) throw e2;
  return created;
}

async function consumePlan(tg_id, payload) {
  const { data, error } = await supabase.rpc("consume_plan_and_save", {
    p_tg_id: tg_id,
    p_plan: payload,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

// =========================
// API
// =========================
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/api/plan", async (req, res) => {
  try {
    const { tg_id, mode = "chat", text = "", history = [], profile = {} } = req.body;

    console.log("[/api/plan]", { mode, tg_id, text_len: text.length });

    if (!Number.isFinite(Number(tg_id)))
      return res.status(400).json({ error: "tg_id_required" });

    const user = await getUser(Number(tg_id));
    const transcript = buildTranscript(history);

    // ================= CHAT =================
    if (mode === "chat") {
      if (!text.trim())
        return res.status(400).json({ error: "text_required" });

      const prompt = `
Ты — LSD, умный и дружелюбный помощник.
Отвечай кратко, по делу, на русском.
НЕ создавай планы и JSON.

История:
${transcript}

Сообщение:
${text}
`.trim();

      const answer = await callGemini(prompt);
      return res.json({
        text: answer,
        cards: [],
        tier: user.tier,
        plans_left: user.plans_left,
      });
    }

    // ================= PLAN =================
    if (user.tier !== "developer" && user.plans_left <= 0) {
      return res.status(403).json({
        error: "no_plans_left",
        plans_left: user.plans_left,
      });
    }

    const prompt = `
Ты — LSD.
Сделай план задач по переписке.

Формат строго:
@@LSD_JSON_START@@
{ "cards": [ { "title": "...", "tasks": [ { "t": "...", "min": 30, "energy": "focus" } ] } ] }
@@LSD_JSON_END@@

История:
${transcript || text}
`.trim();

    const raw = await callGemini(prompt);
    const parsed = extractCards(raw);

    if (!parsed.cards.length) {
      return res.json({
        text: parsed.text,
        cards: [],
        plans_left: user.plans_left,
      });
    }

    if (user.tier === "developer") {
      await supabase
        .from("lsd_users")
        .update({ current_plan: parsed })
        .eq("tg_id", tg_id);

      return res.json({
        text: parsed.text,
        cards: parsed.cards,
        plans_left: user.plans_left,
      });
    }

    const r = await consumePlan(tg_id, parsed);

    return res.json({
      text: parsed.text,
      cards: parsed.cards,
      plans_left: r.plans_left,
    });
  } catch (e) {
    console.error("SERVER ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on ${PORT}`);
});
