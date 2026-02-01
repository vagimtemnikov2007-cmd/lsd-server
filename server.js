import express from "express";
import dotenv from "dotenv";

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

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY не найден в .env");
  process.exit(1);
}

// health check
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/models", async (req, res) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "list_models_failed" });
  }
});

// =========================
// HELPERS
// =========================
function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeHistory(history) {
  // ожидаем [{role:'user'|'assistant', content:'...'}]
  if (!Array.isArray(history)) return [];
  return history
    .map((m) => ({
      role: m?.role === "assistant" ? "assistantица:assistant" : "user", // role не так важен, просто метка
      content: safeStr(m?.content).trim(),
    }))
    .filter((m) => m.content.length > 0)
    .map((m) => ({
      role: m.role === "user" ? "User" : "AI",
      content: m.content,
    }));
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

  // текст без JSON блока
  let cleanText = (rawText.slice(0, start) + rawText.slice(end + END.length)).trim();
  if (!cleanText) cleanText = rawText.trim();

  try {
    const parsed = JSON.parse(jsonBlock);
    const cards = Array.isArray(parsed?.cards) ? parsed.cards : [];
    return { cleanText, cards, found: true, jsonError: null };
  } catch (e) {
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
    return { ok: false, status: resp.status, error: msg, raw: rawJson };
  }

  const text =
    rawJson?.candidates?.[0]?.content?.parts
      ?.map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim() || "";

  return { ok: true, text, raw: rawJson };
}

// =========================
// MAIN ENDPOINT
// =========================
app.post("/api/plan", async (req, res) => {
  try {
    const body = req.body || {};
    const mode = body.mode === "plan" ? "plan" : "chat"; // default chat

    const profile = body.profile || {};
    const history = body.history;       // массив
    const transcript = safeStr(body.transcript); // строка
    const text = safeStr(body.text).trim();      // последнее сообщение

    // Собираем полный контекст:
    const historyTranscript =
      transcript.trim() ||
      buildTranscriptFromHistory(history) ||
      "";

    // === Валидация ===
    // chat: нужно последнее сообщение text
    if (mode === "chat") {
      if (!text) return res.status(400).json({ error: "text_required" });
    }

    // plan: можно без text, главное чтобы была история
    if (mode === "plan") {
      const hasAnyContext = !!historyTranscript.trim() || !!text;
      if (!hasAnyContext) return res.status(400).json({ error: "history_required" });
    }

    // === PROMPTS ===
    const profileBlock = `
Профиль пользователя:
nick: ${profile?.nick || ""}
age: ${profile?.age ?? ""}
bio: ${profile?.bio || ""}
`.trim();

    let prompt = "";

    if (mode === "chat") {
      // ✅ обычный чат-режим (БЕЗ карточек)
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
      // ✅ режим плана (ТОЛЬКО по кнопке "Создать план")
      prompt = `
Ты — LSD (AI Time Manager).
Задача: СДЕЛАЙ ПЛАН в виде карточек на основе ВСЕЙ переписки.
Сначала можно 1 короткую фразу (не обязательно), но ГЛАВНОЕ — верни JSON строго между маркерами.

Требования к карточкам:
- 1–4 карточки
- в каждой карточке 3–6 задач
- задачи должны быть конкретные, маленькие, выполнимые
- min: 10..180 (минуты)
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

    // === CALL GEMINI ===
    const out = await callGemini(prompt);

    if (!out.ok) {
      return res.status(out.status).json({ error: out.error });
    }

    if (!out.text) {
      return res.json({ text: "", cards: [], debug: "empty_text" });
    }

    // === RESPONSE FORMATTING ===
    if (mode === "chat") {
      // chat mode -> только текст
      return res.json({ text: out.text, cards: [] });
    }

    // plan mode -> парсим cards
    const parsed = extractJsonCards(out.text);

    if (!parsed.cards.length) {
      // если Gemini “забыл” JSON — вернём ошибку, чтобы ты видел
      return res.json({
        text: parsed.cleanText,
        cards: [],
        error: parsed.found ? "plan_json_invalid" : "plan_json_missing",
      });
    }

    return res.json({ text: parsed.cleanText, cards: parsed.cards });
  } catch (e) {
    console.error("SERVER ERROR:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
});
