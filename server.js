import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY не найден в .env");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не найдены в .env");
  process.exit(1);
}

// ✅ Supabase client (ВАЖНО: service_role — только на сервере)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// health check
app.get("/health", (req, res) => res.json({ ok: true }));

// =========================
// HELPERS (Gemini)
// =========================
function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((m) => ({
      role: m?.role === "assistant" ? "AI" : "User",
      content: safeStr(m?.content).trim(),
    }))
    .filter((m) => m.content.length > 0);
}

function buildTranscriptFromHistory(history) {
  const h = normalizeHistory(history);
  return h.map((m) => `${m.role}: ${m.content}`).join("\n");
}

function extractJsonCards(rawText) {
  const START = "@@LSD_JSON_START@@";
  const END = "@@LSD_JSON_END@@";

  const start = rawText.indexOf(START);
  const end = rawText.indexOf(END);

  if (start === -1 || end === -1 || end <= start) {
    return { cleanText: rawText.trim(), cards: [], found: false, jsonError: null };
  }

  const jsonBlock = rawText.slice(start + START.length, end).trim();
  let cleanText = (rawText.slice(0, start) + rawText.slice(end + END.length)).trim();
  if (!cleanText) cleanText = rawText.trim();

  try {
    const parsed = JSON.parse(jsonBlock);
    const cards = Array.isArray(parsed?.cards) ? parsed.cards : [];
    return { cleanText, cards, found: true, jsonError: null };
  } catch {
    return { cleanText, cards: [], found: true, jsonError: "bad_json" };
  }
}

async function callGemini(prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6 },
    }),
  });

  const rawJson = await resp.json();

  if (!resp.ok) {
    const msg = rawJson?.error?.message || "gemini_error";
    return { ok: false, status: resp.status, error: msg };
  }

  const text =
    rawJson?.candidates?.[0]?.content?.parts
      ?.map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim() || "";

  return { ok: true, text };
}

// =========================
// DB HELPERS
// =========================

// 1) получить / создать пользователя по tg_id
async function getOrCreateUserByTgId(tg_id) {
  // tg_id обязателен
  if (!Number.isFinite(tg_id)) throw new Error("bad_tg_id");

  // пробуем взять
  const { data: found, error: selErr } = await supabase
    .from("lsd_users")
    .select("*")
    .eq("tg_id", tg_id)
    .maybeSingle();

  if (selErr) throw selErr;
  if (found) return found;

  // создаём
  const { data: created, error: insErr } = await supabase
    .from("lsd_users")
    .insert({ tg_id })
    .select("*")
    .single();

  if (insErr) throw insErr;
  return created;
}

// 2) атомарно списать план и сохранить current_plan через RPC
async function consumePlanAndSave(tg_id, planJson) {
  const { data, error } = await supabase.rpc("consume_plan_and_save", {
    p_tg_id: tg_id,
    p_plan: planJson ?? {},
  });

  if (error) throw error;

  // RPC returns array rows in supabase-js
  const row = Array.isArray(data) ? data[0] : data;
  return row; // { ok, plans_left, user_row }
}

// =========================
// MAIN ENDPOINT
// =========================
//
// ВАЖНО: теперь клиент должен присылать tg_id (из Telegram WebApp)
// body: { tg_id, mode, text, profile, history, transcript }
//
app.post("/api/plan", async (req, res) => {
  try {
    const body = req.body || {};
    const mode = body.mode === "plan" ? "plan" : "chat"; // default chat

    // ✅ tg_id (обязателен)
    const tg_id = Number(body.tg_id);
    if (!Number.isFinite(tg_id)) {
      return res.status(400).json({ error: "tg_id_required" });
    }

    const profile = body.profile || {};
    const history = body.history;
    const transcript = safeStr(body.transcript);
    const text = safeStr(body.text).trim();

    // контекст
    const historyTranscript =
      transcript.trim() || buildTranscriptFromHistory(history) || "";

    // создадим пользователя (или возьмём)
    const user = await getOrCreateUserByTgId(tg_id);

    // chat: нужно text
    if (mode === "chat") {
      if (!text) return res.status(400).json({ error: "text_required" });
    }

    // plan: нужен контекст
    if (mode === "plan") {
      const hasAnyContext = !!historyTranscript.trim() || !!text;
      if (!hasAnyContext) return res.status(400).json({ error: "history_required" });

      // ✅ проверка лимита на сервере до вызова AI (экономим деньги)
      if ((user.plans_left ?? 0) <= 0) {
        return res.status(403).json({ error: "no_plans_left", plans_left: user.plans_left ?? 0 });
      }
    }

    const profileBlock = `
Профиль пользователя:
nick: ${profile?.nick || ""}
age: ${profile?.age ?? ""}
bio: ${profile?.bio || ""}
`.trim();

    let prompt = "";

    if (mode === "chat") {
      prompt = `
Ты — LSD (AI Time Manager). Ты дружелюбный и умный собеседник.
Твоя цель — обсуждать тему с пользователем, задавать уточняющие вопросы, помогать думать.

ВАЖНО:
- НЕ создавай карточки и НЕ выводи JSON.
- Учитывай историю диалога ниже.
- Отвечай на русском, кратко и по делу.

${profileBlock}

История диалога:
${historyTranscript}

Последнее сообщение пользователя:
${text}
`.trim();
    } else {
      prompt = `
Ты — LSD (AI Time Manager).
Задача: СДЕЛАЙ ПЛАН в виде карточек на основе ВСЕЙ переписки.
Сначала можно 1 короткую фразу (не обязательно), но ГЛАВНОЕ — верни JSON строго между маркерами.

Требования к карточкам:
- 1–4 карточки
- в каждой карточке 3–6 задач
- задачи конкретные, маленькие, выполнимые
- min: 10..180
- energy: "focus" | "easy" | "hard"

Формат (строго):
@@LSD_JSON_START@@
{ "cards": [ { "title": "...", "tasks": [ { "t": "...", "min": 30, "energy": "focus" } ] } ] }
@@LSD_JSON_END@@

${profileBlock}

ВСЯ переписка:
${historyTranscript || text}
`.trim();
    }

    // call AI
    const out = await callGemini(prompt);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    if (!out.text) return res.json({ text: "", cards: [], debug: "empty_text" });

    // chat -> только текст
    if (mode === "chat") {
      return res.json({ text: out.text, cards: [] });
    }

    // plan -> parse cards
    const parsed = extractJsonCards(out.text);

    // если нет карточек — вернём ошибку (без списания лимита)
    if (!parsed.cards.length) {
      return res.json({
        text: parsed.cleanText,
        cards: [],
        error: parsed.found ? "plan_json_invalid" : "plan_json_missing",
      });
    }

    // ✅✅✅ ВОТ ТУТ МЫ СПИСЫВАЕМ ПЛАН И СОХРАНЯЕМ current_plan АТОМАРНО
    const savePayload = {
      cards: parsed.cards,
      text: parsed.cleanText,
      created_at: new Date().toISOString(),
    };

    const r = await consumePlanAndSave(tg_id, savePayload);

    if (!r?.ok) {
      // если лимит закончился прямо сейчас (гонка) — сообщаем
      return res.status(403).json({
        error: "no_plans_left",
        plans_left: r?.plans_left ?? 0,
      });
    }

    return res.json({
      text: parsed.cleanText,
      cards: parsed.cards,
      plans_left: r.plans_left,
    });
  } catch (e) {
    console.error("SERVER ERROR:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
});
