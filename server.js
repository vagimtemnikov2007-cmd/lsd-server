import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "8mb" }));

// CORS
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
  console.error("❌ Missing ENV: GEMINI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.get("/health", (_, res) => res.json({ ok: true }));

// =========================
// HELPERS
// =========================
const safeStr = (x) => (typeof x === "string" ? x : "");
const nowISO = () => new Date().toISOString();

function buildTranscriptFromMessages(msgs) {
  return (msgs || [])
    .map((m) => `${m.role === "assistant" ? "AI" : "User"}: ${safeStr(m.content).trim()}`)
    .filter(Boolean)
    .join("\n");
}

function extractCards(text) {
  const START = "@@LSD_JSON_START@@";
  const END = "@@LSD_JSON_END@@";
  const s = text.indexOf(START);
  const e = text.indexOf(END);

  if (s === -1 || e === -1 || e <= s) return { cleanText: text.trim(), cards: [], ok: false };

  const jsonBlock = text.slice(s + START.length, e).trim();
  const cleanText = (text.slice(0, s) + text.slice(e + END.length)).trim() || text.trim();

  try {
    const parsed = JSON.parse(jsonBlock);
    const cards = Array.isArray(parsed?.cards) ? parsed.cards : [];
    return { cleanText, cards, ok: cards.length > 0 };
  } catch {
    return { cleanText, cards: [], ok: false };
  }
}

async function callGemini(prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6 },
    }),
  });

  const json = await r.json();
  if (!r.ok) {
    throw new Error(json?.error?.message || `gemini_error_${r.status}`);
  }

  const out =
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || "";

  return out;
}

// =========================
// DB HELPERS
// =========================
async function getOrCreateUser(tg_id) {
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

async function getOrCreateChat(tg_id, chat_id, title = "Чат") {
  const { data, error } = await supabase
    .from("lsd_chats")
    .select("*")
    .eq("tg_id", tg_id)
    .eq("chat_id", chat_id)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: created, error: e2 } = await supabase
    .from("lsd_chats")
    .insert({ tg_id, chat_id, title })
    .select("*")
    .single();

  if (e2) throw e2;
  return created;
}

async function insertMessage({ tg_id, chat_id, role, content }) {
  const { error } = await supabase.from("lsd_messages").insert({
    tg_id,
    chat_id,
    role,        // "user" | "assistant"
    content,
    created_at: nowISO(),
  });
  if (error) throw error;
}

async function loadChatMessages({ tg_id, chat_id, limit = 80 }) {
  const { data, error } = await supabase
    .from("lsd_messages")
    .select("role, content, created_at")
    .eq("tg_id", tg_id)
    .eq("chat_id", chat_id)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// =========================
// API: CHAT SEND
// =========================
app.post("/api/chat/send", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chat_id = safeStr(req.body?.chat_id);
    const text = safeStr(req.body?.text).trim();
    const profile = req.body?.profile || {};

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "tg_id_required" });
    if (!chat_id) return res.status(400).json({ error: "chat_id_required" });
    if (!text) return res.status(400).json({ error: "text_required" });

    const user = await getOrCreateUser(tg_id);

    // ensure chat exists
    await getOrCreateChat(tg_id, chat_id, text.slice(0, 32) || "Чат");

    // save user msg
    await insertMessage({ tg_id, chat_id, role: "user", content: text });

    // load history from DB
    const msgs = await loadChatMessages({ tg_id, chat_id, limit: 80 });
    const transcript = buildTranscriptFromMessages(msgs);

    const profileBlock = `
Профиль пользователя:
nick: ${profile?.nick || ""}
age: ${profile?.age ?? ""}
bio: ${profile?.bio || ""}
`.trim();

    const prompt = `
Ты — LSD (AI Time Manager). Ты дружелюбный и умный собеседник.
Отвечай на русском, кратко и по делу.

ВАЖНО:
- НЕ создавай JSON и планы.
- Учитывай историю ниже.

${profileBlock}

История:
${transcript}

Последнее сообщение:
${text}
`.trim();

    const answer = await callGemini(prompt);

    // save assistant msg
    await insertMessage({ tg_id, chat_id, role: "assistant", content: answer || "" });

    return res.json({
      ok: true,
      text: answer || "",
      tier: user.tier,
      plans_left: user.plans_left,
    });
  } catch (e) {
    console.error("CHAT ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// =========================
// API: PLAN CREATE
// =========================
app.post("/api/plan/create", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chat_id = safeStr(req.body?.chat_id);
    const profile = req.body?.profile || {};

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "tg_id_required" });
    if (!chat_id) return res.status(400).json({ error: "chat_id_required" });

    const user = await getOrCreateUser(tg_id);
    const tier = safeStr(user?.tier) || "free";
    const plansLeft = Number.isFinite(user?.plans_left) ? user.plans_left : 0;

    // limit check
    if (tier !== "developer" && plansLeft <= 0) {
      return res.status(403).json({ error: "no_plans_left", plans_left: plansLeft, tier });
    }

    const msgs = await loadChatMessages({ tg_id, chat_id, limit: 120 });
    const transcript = buildTranscriptFromMessages(msgs);
    if (!transcript.trim()) return res.json({ cards: [], text: "", tier, plans_left: plansLeft });

    const profileBlock = `
Профиль пользователя:
nick: ${profile?.nick || ""}
age: ${profile?.age ?? ""}
bio: ${profile?.bio || ""}
`.trim();

    const prompt = `
Ты — LSD (AI Time Manager).
Задача: сделать план в виде карточек на основе переписки.

Требования:
- 1–4 карточки
- в каждой карточке 3–6 задач
- задачи конкретные
- min: 10..180
- energy: "focus" | "easy" | "hard"

Формат строго:
@@LSD_JSON_START@@
{ "cards": [ { "title": "...", "tasks": [ { "t": "...", "min": 30, "energy": "focus" } ] } ] }
@@LSD_JSON_END@@

${profileBlock}

Переписка:
${transcript}
`.trim();

    const raw = await callGemini(prompt);
    const parsed = extractCards(raw);

    if (!parsed.ok) {
      return res.json({ cards: [], text: parsed.cleanText, tier, plans_left: plansLeft, error: "plan_json_invalid" });
    }

    // save plan (and consume if needed)
    const payload = { cards: parsed.cards, text: parsed.cleanText, created_at: nowISO(), chat_id };

    if (tier === "developer") {
      await supabase.from("lsd_users").update({ current_plan: payload }).eq("tg_id", tg_id);
      return res.json({ cards: parsed.cards, text: parsed.cleanText, tier, plans_left: plansLeft });
    }

    // consume using your RPC if you have it
    const { data, error } = await supabase.rpc("consume_plan_and_save", {
      p_tg_id: tg_id,
      p_plan: payload,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    return res.json({
      cards: parsed.cards,
      text: parsed.cleanText,
      tier,
      plans_left: row?.plans_left ?? 0,
    });
  } catch (e) {
    console.error("PLAN ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// =========================
// API: USER INIT (create user on app open)
// =========================
app.post("/api/user/init", async (req, res) => {
  try {
    const tg_id = getTgIdOrNull() ?? 999999999;
    const profile = req.body?.profile || {};

    if (!Number.isFinite(tg_id)) {
      return res.status(400).json({ error: "tg_id_required" });
    }

    const user = await getOrCreateUser(tg_id);

    return res.json({
      ok: true,
      tier: user.tier,
      plans_left: user.plans_left,
    });
  } catch (e) {
    console.error("USER INIT ERROR:", e);
    return res.status(500).json({
      error: "server_error",
      details: String(e.message || e),
    });
  }
});
  

app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
