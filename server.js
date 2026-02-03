import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import crypto from "crypto";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

// --------------------
// CONFIG
// --------------------
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// bucket name in Supabase Storage (optional)
const STORAGE_BUCKET = process.env.SUPABASE_BUCKET || "lsd_uploads";

// OpenAI model (Responses API)
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // пример из docs-гайдов :contentReference[oaicite:1]{index=1}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ SUPABASE env is missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
}
if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY is missing.");
}

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

// --------------------
// MIDDLEWARE
// --------------------
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "12mb" }));

// multer (memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// --------------------
// HELPERS
// --------------------
function uid() {
  return crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex");
}

function nowISO() {
  return new Date().toISOString();
}

function safeParseJSON(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function isImageMime(mime) {
  return typeof mime === "string" && mime.startsWith("image/");
}

function toBase64(buffer) {
  return buffer.toString("base64");
}

async function openaiResponses({ input }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      // Можно добавить temperature при желании
    }),
  });

  const raw = await res.text();
  const data = safeParseJSON(raw, { error: "bad_json_from_openai", raw });

  return { ok: res.ok, status: res.status, data };
}

// вытаскиваем “чистый текст” из responses
function extractResponseText(respJson) {
  // Responses API может возвращать output массив, где есть content с type=output_text
  const out = respJson?.output;
  if (!Array.isArray(out)) return "";

  let text = "";
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
    }
  }
  return text.trim();
}

async function ensureUserRow(tg_id, profile = {}) {
  if (!supabase) return { ok: true };

  const { data, error } = await supabase
    .from("users")
    .upsert(
      {
        tg_id,
        profile,
        updated_at: nowISO(),
        created_at: nowISO(),
      },
      { onConflict: "tg_id" }
    )
    .select()
    .single();

  if (error) return { ok: false, error };
  return { ok: true, data };
}

async function upsertChat(tg_id, chat_id, title = "Новый чат", emoji = "💬", updated_at = nowISO()) {
  if (!supabase) return { ok: true };
  const { error } = await supabase.from("chats").upsert(
    {
      tg_id,
      chat_id,
      title,
      emoji,
      updated_at,
      created_at: nowISO(),
    },
    { onConflict: "chat_id" }
  );
  return error ? { ok: false, error } : { ok: true };
}

async function insertMessage({ tg_id, chat_id, msg_id, role, content, created_at }) {
  if (!supabase) return { ok: true };
  const { error } = await supabase.from("messages").upsert(
    {
      tg_id,
      chat_id,
      msg_id,
      role,
      content,
      created_at: created_at || nowISO(),
    },
    { onConflict: "msg_id" }
  );
  return error ? { ok: false, error } : { ok: true };
}

async function saveUserState({ tg_id, tasks_state, points }) {
  if (!supabase) return { ok: true };
  const { error } = await supabase.from("user_state").upsert(
    {
      tg_id,
      tasks_state,
      points,
      updated_at: nowISO(),
      created_at: nowISO(),
    },
    { onConflict: "tg_id" }
  );
  return error ? { ok: false, error } : { ok: true };
}

async function loadUserState(tg_id) {
  if (!supabase) return { ok: true, data: { tasks_state: { groups: [] }, points: 0 } };

  const { data, error } = await supabase.from("user_state").select("*").eq("tg_id", tg_id).maybeSingle();
  if (error) return { ok: false, error };

  return {
    ok: true,
    data: data || { tasks_state: { groups: [] }, points: 0 },
  };
}

async function uploadToSupabaseStorage({ buffer, contentType, tg_id, chat_id, originalName }) {
  if (!supabase) return { ok: false, error: "supabase_not_configured" };

  const ext = (originalName || "file").split(".").pop();
  const path = `${tg_id}/${chat_id}/${Date.now()}_${uid()}.${ext}`;

  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
    contentType: contentType || "application/octet-stream",
    upsert: false,
  });

  if (error) return { ok: false, error };

  // public URL (если bucket public). Если private — делай signed URL.
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return { ok: true, path, url: data?.publicUrl || null };
}

function buildChatInputFromHistory(history, newUserItem) {
  // history: [{role:"user"/"assistant", content:"..."}, ...]
  // Responses API input: array of {role, content:[{type:"input_text", text:"..."}]}
  const input = [];

  for (const m of history) {
    if (!m?.content) continue;
    input.push({
      role: m.role,
      content: [{ type: "input_text", text: String(m.content) }],
    });
  }

  // add new user item
  input.push(newUserItem);

  // system instruction
  input.unshift({
    role: "system",
    content: [
      {
        type: "input_text",
        text:
          "Ты — ассистент LSD. Отвечай по-русски. Если пользователь прикрепил файл/фото — сначала коротко скажи что видишь/что это, потом помоги по задаче. Если данных мало — задай 1 уточняющий вопрос.",
      },
    ],
  });

  return input;
}

// --------------------
// ROUTES
// --------------------
app.get("/", (_req, res) => res.send("LSD server OK"));

// init user
app.post("/api/user/init", async (req, res) => {
  const tg_id = Number(req.body?.tg_id);
  const profile = req.body?.profile || {};

  if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "bad_tg_id" });

  const u = await ensureUserRow(tg_id, profile);
  if (!u.ok) return res.status(500).json({ error: "supabase_user_upsert_failed", details: String(u.error?.message || u.error) });

  const st = await loadUserState(tg_id);
  if (!st.ok) return res.status(500).json({ error: "supabase_state_load_failed", details: String(st.error?.message || st.error) });

  return res.json({
    ok: true,
    points: Number(st.data?.points || 0),
    tasks_state: st.data?.tasks_state || { groups: [] },
  });
});

// send chat message (text)
app.post("/api/chat/send", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chat_id = String(req.body?.chat_id || "");
    const text = String(req.body?.text || "").trim();
    const msg_id = String(req.body?.msg_id || uid());
    const profile = req.body?.profile || {};

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "bad_tg_id" });
    if (!chat_id) return res.status(400).json({ error: "bad_chat_id" });
    if (!text) return res.status(400).json({ error: "empty_text" });

    await ensureUserRow(tg_id, profile);
    await upsertChat(tg_id, chat_id, "Новый чат", "💬", nowISO());

    // store user message
    await insertMessage({ tg_id, chat_id, msg_id, role: "user", content: text, created_at: nowISO() });

    // load last history for context
    let history = [];
    if (supabase) {
      const { data: rows } = await supabase
        .from("messages")
        .select("role, content, created_at")
        .eq("chat_id", chat_id)
        .order("created_at", { ascending: true })
        .limit(60);

      history = (rows || []).map((r) => ({ role: r.role, content: r.content }));
    }

    if (!OPENAI_API_KEY) {
      const fallback = "OPENAI_API_KEY не задан. Я сохранил сообщение, но не могу спросить ИИ.";
      await insertMessage({ tg_id, chat_id, msg_id: uid(), role: "assistant", content: fallback, created_at: nowISO() });
      return res.json({ text: fallback });
    }

    const input = buildChatInputFromHistory(history.slice(-40), {
      role: "user",
      content: [{ type: "input_text", text }],
    });

    const ai = await openaiResponses({ input });
    if (!ai.ok) return res.status(502).json({ error: "openai_failed", details: ai.data });

    const answer = extractResponseText(ai.data) || "AI вернул пустой ответ 😶";

    // store assistant message
    await insertMessage({ tg_id, chat_id, msg_id: uid(), role: "assistant", content: answer, created_at: nowISO() });

    // return (points may be updated by sync elsewhere; keep compatible with твоим фронтом)
    return res.json({ text: answer });
  } catch (e) {
    return res.status(500).json({ error: "server_exception", details: String(e?.message || e) });
  }
});

// attach file/photo
app.post("/api/chat/attach", upload.single("file"), async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chat_id = String(req.body?.chat_id || "");
    const kind = String(req.body?.kind || "file"); // "photo" | "file"
    const profile = safeParseJSON(req.body?.profile || "{}", {}) || {};

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "bad_tg_id" });
    if (!chat_id) return res.status(400).json({ error: "bad_chat_id" });
    if (!req.file) return res.status(400).json({ error: "no_file" });

    await ensureUserRow(tg_id, profile);
    await upsertChat(tg_id, chat_id, "Новый чат", "💬", nowISO());

    const file = req.file;
    const fileName = file.originalname || "upload";
    const mime = file.mimetype || "application/octet-stream";
    const size = Number(file.size || 0);

    // 1) по желанию сохраняем в Supabase Storage и даём ссылку
    let uploadedUrl = null;
    if (supabase) {
      const up = await uploadToSupabaseStorage({
        buffer: file.buffer,
        contentType: mime,
        tg_id,
        chat_id,
        originalName: fileName,
      });
      if (up.ok) uploadedUrl = up.url;
    }

    // 2) сохраняем “событие” как сообщение пользователя (чтобы история была целой)
    const userLabel =
      kind === "photo"
        ? `📷 Фото: ${fileName} (${Math.round(size / 1024)} KB)`
        : `📎 Файл: ${fileName} (${Math.round(size / 1024)} KB)`;

    await insertMessage({ tg_id, chat_id, msg_id: uid(), role: "user", content: userLabel, created_at: nowISO() });

    if (!OPENAI_API_KEY) {
      const fallback = "OPENAI_API_KEY не задан. Файл/фото сохранил, но не могу отправить ИИ.";
      await insertMessage({ tg_id, chat_id, msg_id: uid(), role: "assistant", content: fallback, created_at: nowISO() });
      return res.json({ text: fallback });
    }

    // load history
    let history = [];
    if (supabase) {
      const { data: rows } = await supabase
        .from("messages")
        .select("role, content, created_at")
        .eq("chat_id", chat_id)
        .order("created_at", { ascending: true })
        .limit(60);
      history = (rows || []).map((r) => ({ role: r.role, content: r.content }));
    }

    // 3) строим input для OpenAI
    let userItem;

    if (isImageMime(mime)) {
      // Отправляем как input_image. :contentReference[oaicite:2]{index=2}
      const b64 = toBase64(file.buffer);
      const dataUrl = `data:${mime};base64,${b64}`;

      userItem = {
        role: "user",
        content: [
          { type: "input_text", text: "Проанализируй прикреплённое изображение и помоги по запросу пользователя." },
          { type: "input_image", image_url: dataUrl, detail: "auto" },
        ],
      };
    } else {
      // Не изображение: даём ссылку (если есть) + мету
      const metaText =
        `Пользователь прикрепил файл.\n` +
        `Имя: ${fileName}\nMIME: ${mime}\nРазмер: ${size} bytes\n` +
        (uploadedUrl ? `Ссылка: ${uploadedUrl}\n` : "") +
        `Если файл бинарный/не читается — попроси пользователя вставить текст/скрин/контент, который нужно обработать.`;

      userItem = {
        role: "user",
        content: [{ type: "input_text", text: metaText }],
      };
    }

    const input = buildChatInputFromHistory(history.slice(-35), userItem);

    const ai = await openaiResponses({ input });
    if (!ai.ok) return res.status(502).json({ error: "openai_failed", details: ai.data });

    const answer = extractResponseText(ai.data) || "AI вернул пустой ответ 😶";

    await insertMessage({ tg_id, chat_id, msg_id: uid(), role: "assistant", content: answer, created_at: nowISO() });

    return res.json({ text: answer });
  } catch (e) {
    return res.status(500).json({ error: "server_exception", details: String(e?.message || e) });
  }
});

// plan create (возвращает cards как ожидает твой фронт)
app.post("/api/plan/create", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chat_id = String(req.body?.chat_id || "");
    const profile = req.body?.profile || {};

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "bad_tg_id" });
    if (!chat_id) return res.status(400).json({ error: "bad_chat_id" });

    // соберём немного истории (последние ~25 сообщений)
    let historyText = "";
    if (supabase) {
      const { data: rows } = await supabase
        .from("messages")
        .select("role, content")
        .eq("chat_id", chat_id)
        .order("created_at", { ascending: true })
        .limit(50);

      historyText = (rows || [])
        .map((r) => `${r.role === "assistant" ? "AI" : "USER"}: ${r.content}`)
        .join("\n");
    }

    if (!OPENAI_API_KEY) return res.json({ cards: [] });

    const instruction =
      `Сделай план задач в формате JSON.\n` +
      `Верни строго JSON без лишнего текста.\n` +
      `Схема:\n` +
      `{"cards":[{"title":"строка","tasks":[{"t":"строка","min":number,"energy":"low|med|high"}]}]}\n` +
      `Карточек 1-3, задач 3-8.\n` +
      `Учитывай профиль: ${JSON.stringify(profile)}\n` +
      `Контекст чата:\n${historyText}\n`;

    const ai = await openaiResponses({
      input: [
        { role: "system", content: [{ type: "input_text", text: "Ты планировщик задач. Возвращай только JSON." }] },
        { role: "user", content: [{ type: "input_text", text: instruction }] },
      ],
    });

    if (!ai.ok) return res.status(502).json({ error: "openai_failed", details: ai.data });

    const txt = extractResponseText(ai.data);

    // пытаемся парсить
    const obj = safeParseJSON(txt, null);
    const cards = Array.isArray(obj?.cards) ? obj.cards : [];

    return res.json({ cards });
  } catch (e) {
    return res.status(500).json({ error: "server_exception", details: String(e?.message || e) });
  }
});

// sync push (то что твой фронт шлёт)
app.post("/api/sync/push", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "bad_tg_id" });

    const chats_upsert = Array.isArray(req.body?.chats_upsert) ? req.body.chats_upsert : [];
    const messages_upsert = Array.isArray(req.body?.messages_upsert) ? req.body.messages_upsert : [];
    const tasks_state = req.body?.tasks_state || null;
    const points = Number(req.body?.points);

    await ensureUserRow(tg_id, req.body?.profile || {});

    if (supabase) {
      // chats
      for (const c of chats_upsert) {
        if (!c?.chat_id) continue;
        await upsertChat(tg_id, String(c.chat_id), c.title || "Новый чат", c.emoji || "💬", c.updated_at || nowISO());
      }

      // messages
      for (const m of messages_upsert) {
        if (!m?.msg_id || !m?.chat_id) continue;
        await insertMessage({
          tg_id,
          chat_id: String(m.chat_id),
          msg_id: String(m.msg_id),
          role: String(m.role || "user"),
          content: String(m.content || ""),
          created_at: m.created_at || nowISO(),
        });
      }

      // state
      if (tasks_state && typeof tasks_state === "object") {
        await saveUserState({
          tg_id,
          tasks_state,
          points: Number.isFinite(points) ? points : 0,
        });
      } else if (Number.isFinite(points)) {
        // если tasks_state не пришёл, но очки пришли
        const prev = await loadUserState(tg_id);
        const prevTasks = prev.ok ? prev.data?.tasks_state : { groups: [] };
        await saveUserState({ tg_id, tasks_state: prevTasks || { groups: [] }, points });
      }
    }

    // возвращаем “истину” (points) чтобы фронт мог обновляться при желании
    const st = await loadUserState(tg_id);
    const outPoints = st.ok ? Number(st.data?.points || 0) : (Number.isFinite(points) ? points : 0);

    return res.json({ ok: true, points: outPoints });
  } catch (e) {
    return res.status(500).json({ error: "server_exception", details: String(e?.message || e) });
  }
});

// sync pull (то что твой фронт ждёт)
app.post("/api/sync/pull", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "bad_tg_id" });

    if (!supabase) {
      return res.json({
        chats: [],
        messages: [],
        tasks_state: { groups: [] },
        points: 0,
      });
    }

    const { data: chats, error: chatsErr } = await supabase
      .from("chats")
      .select("chat_id,title,emoji,updated_at")
      .eq("tg_id", tg_id)
      .order("updated_at", { ascending: false })
      .limit(200);

    if (chatsErr) return res.status(500).json({ error: "supabase_chats_failed", details: String(chatsErr.message) });

    const chatIds = (chats || []).map((c) => c.chat_id);

    const { data: messages, error: msgErr } = await supabase
      .from("messages")
      .select("chat_id,msg_id,role,content,created_at")
      .eq("tg_id", tg_id)
      .in("chat_id", chatIds.length ? chatIds : ["__none__"])
      .order("created_at", { ascending: true })
      .limit(2000);

    if (msgErr) return res.status(500).json({ error: "supabase_messages_failed", details: String(msgErr.message) });

    const st = await loadUserState(tg_id);
    if (!st.ok) return res.status(500).json({ error: "supabase_state_failed", details: String(st.error?.message || st.error) });

    return res.json({
      chats: chats || [],
      messages: messages || [],
      tasks_state: st.data?.tasks_state || { groups: [] },
      points: Number(st.data?.points || 0),
    });
  } catch (e) {
    return res.status(500).json({ error: "server_exception", details: String(e?.message || e) });
  }
});

// --------------------
// START
// --------------------
app.listen(PORT, () => {
  console.log(`✅ LSD server listening on :${PORT}`);
});
