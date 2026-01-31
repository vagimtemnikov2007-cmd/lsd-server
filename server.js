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

// основной эндпоинт
app.post("/api/plan", async (req, res) => {
  const { text, profile } = req.body || {};

  if (!text) {
    return res.status(400).json({ error: "text_required" });
  }

  const systemPrompt = `
Ты — AI-планировщик LSD.
Сначала ответь пользователю коротким текстом (2–5 предложений).
Затем ОБЯЗАТЕЛЬНО верни JSON между маркерами:

@@LSD_JSON_START@@
{
  "cards": [
    {
      "title": "Название плана",
      "tasks": [
        { "t": "Короткая задача", "min": 10, "energy": "light" }
      ]
    }
  ]
}
@@LSD_JSON_END@@

Правила:
- cards: от 1 до 5
- tasks: от 1 до 8
- energy: только light | focus | hard
- задачи короткие: глагол + объект
`;

  const userPrompt = `
Профиль пользователя:
- псевдоним: ${profile?.nick ?? ""}
- возраст: ${profile?.age ?? ""}
- информация: ${profile?.bio ?? ""}

Запрос:
${text}
`;

  try {
    const MODEL = "gemini-2.0-flash";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: systemPrompt + "\n\n" + userPrompt }],
          },
        ],
        generationConfig: { temperature: 0.4 },
      }),
    });

    const data = await response.json();
    console.log("RAW GEMINI RESPONSE:", JSON.stringify(data, null, 2));

    const textOut =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

    const parsed = extractCards(textOut);

    res.json({
      text: textOut,
      cards: parsed?.cards ?? [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ai_failed" });
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
