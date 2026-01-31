import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS (для локальной разработки)
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
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

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

app.post("/api/plan", async (req, res) => {
  try {
    const { text, profile } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text_required" });
    }

    const prompt = `
Ты — LSD (AI Time Manager).
Задача: помоги пользователю разбить задачу на 3–5 небольших шагов.

Требования к ответу:
1) Сначала обычный текст (коротко, по делу).
2) Потом JSON строго между маркерами:

@@LSD_JSON_START@@
{ "cards": [ { "title": "...", "tasks": [ { "t": "...", "min": 30, "energy": "focus" } ] } ] }
@@LSD_JSON_END@@

Профиль:
nick: ${profile?.nick || ""}
age: ${profile?.age ?? ""}
bio: ${profile?.bio || ""}

Запрос пользователя:
${text}
`.trim();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6 }
      })
    });

    const rawJson = await resp.json();

    if (!resp.ok) {
      const msg = rawJson?.error?.message || "gemini_error";
      return res.status(resp.status).json({ error: msg });
    }

    // ✅ НАДЁЖНО достаём текст
    const rawText =
      rawJson?.candidates?.[0]?.content?.parts
        ?.map(p => (typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim() || "";

    if (!rawText) {
      // чтобы не было "тишины" — вернём debug (временно)
      return res.json({ text: "", cards: [], debug: rawJson });
    }

    // ✅ Парсим JSON блок (если есть)
    const START = "@@LSD_JSON_START@@";
    const END = "@@LSD_JSON_END@@";

    const start = rawText.indexOf(START);
    const end = rawText.indexOf(END);

    let cards = [];
    let cleanText = rawText;

    if (start !== -1 && end !== -1 && end > start) {
      const jsonBlock = rawText.slice(start + START.length, end).trim();

      // текст без JSON блока
      cleanText = (
        rawText.slice(0, start) +
        rawText.slice(end + END.length)
      ).trim();

      try {
        const parsed = JSON.parse(jsonBlock);
        if (Array.isArray(parsed?.cards)) cards = parsed.cards;
      } catch {
        // JSON сломан — карточки пустые, но текст всё равно отдаём
        cards = [];
      }
    }

    // ✅ Гарантия: если cleanText пустой — отдай rawText
    if (!cleanText) cleanText = rawText;

    return res.json({ text: cleanText, cards });

  } catch (e) {
    console.error("SERVER ERROR:", e);
    return res.status(500).json({ error: "server_error" });
  }
});


function extractCards(fullText) {
  const start = "@@LSD_JSON_START@@";
  const end = "@@LSD_JSON_END@@";

  const a = fullText.indexOf(start);
  const b = fullText.indexOf(end);

  if (a === -1 || b === -1 || b <= a) return null;

  const jsonStr = fullText.slice(a + start.length, b).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
});
