import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import crypto from "crypto";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "8mb" }));

// -------------------------
// CORS (simple)
// -------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -------------------------
// ENV
// -------------------------
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing ENV: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY is missing — chat/plan/media endpoints will fail.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -------------------------
// Utils
// -------------------------
const safeStr = (x) => (typeof x === "string" ? x : "");
const nowISO = () => new Date().toISOString();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`);

function isPremiumActive(user) {
  const until = user?.premium_until ? new Date(user.premium_until).getTime() : 0;
  return !!until && until > Date.now();
}

function effectiveTier(user) {
  const t = safeStr(user?.tier).toLowerCase();
  if (t === "developer") return "developer";
  return isPremiumActive(user) ? "premium" : "free";
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------------
// Daily quotas (Almaty midnight)
// -------------------------
// Asia/Almaty ~ UTC+5 (обычно без DST). Нам нужна "полночь Алматы".
const RESET_TZ_OFFSET_MIN = 5 * 60;

// Лимиты в день (можешь менять)
const DAILY_LIMITS = {
  free: { plans: 3, media: 3 },
  premium: { plans: 30, media: 30 },
  developer: { plans: Infinity, media: Infinity },
};

function tierNorm(tier) {
  const t = safeStr(tier).toLowerCase();
  return t === "premium" || t === "developer" ? t : "free";
}

function nextAlmatyMidnightISO(fromDate = new Date()) {
  const ms = fromDate.getTime();
  const local = new Date(ms + RESET_TZ_OFFSET_MIN * 60 * 1000);
  const next = new Date(local);
  next.setHours(24, 0, 0, 0); // следующая полночь локальная
  const utcMs = next.getTime() - RESET_TZ_OFFSET_MIN * 60 * 1000;
  return new Date(utcMs).toISOString();
}

function msUntil(iso) {
  const t = new Date(iso).getTime();
  return Math.max(0, t - Date.now());
}

function fmtMsLeft(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

function resetInfo(reset_at) {
  const iso = safeStr(reset_at) || nextAlmatyMidnightISO(new Date());
  const ms = msUntil(iso);
  return {
    quota_reset_at: iso,
    quota_reset_in_sec: Math.ceil(ms / 1000),
    quota_reset_in_human: fmtMsLeft(ms),
    quota_reset_at_local: new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" }),
  };
}

/**
 * Ensure user exists + ensure quotas not expired.
 * If expired -> reset plans_left/media_left based on tier + set next reset.
 */
async function getOrCreateUserAndFreshen(tg_id) {
  // 1) try load
  const { data: existing, error } = await supabase
    .from("lsd_users")
    .select("*")
    .eq("tg_id", tg_id)
    .maybeSingle();

  if (error) throw error;

  const nextReset = nextAlmatyMidnightISO(new Date());

  // 2) create if missing
  if (!existing) {
    const limits = DAILY_LIMITS.free;
    const { data: created, error: e2 } = await supabase
      .from("lsd_users")
      .insert({
        tg_id,
        tier: "free",
        plans_left: limits.plans,
        media_left: limits.media,
        quota_next_reset_at: nextReset,
        updated_at: nowISO(),
      })
      .select("*")
      .single();
    if (e2) throw e2;
    return created;
  }

  // 3) if missing quota_next_reset_at -> set it
  let user = existing;
  if (!user.quota_next_reset_at) {
    const { data: patched, error: e3 } = await supabase
      .from("lsd_users")
      .update({ quota_next_reset_at: nextReset, updated_at: nowISO() })
      .eq("tg_id", tg_id)
      .select("*")
      .single();
    if (e3) throw e3;
    user = patched;
  }

  // 4) if due -> reset
  const due = Date.now() >= new Date(user.quota_next_reset_at).getTime();
  if (due) {
const tier = effectiveTier(user);
const lim = DAILY_LIMITS[tier];


    const patch = {
      quota_next_reset_at: nextAlmatyMidnightISO(new Date()),
      updated_at: nowISO(),
    };

    // developer: можно оставить как есть (но логичнее держать "очень большое" или null)
    if (Number.isFinite(lim.plans)) patch.plans_left = lim.plans;
    if (Number.isFinite(lim.media)) patch.media_left = lim.media;

    const { data: updated, error: e4 } = await supabase
      .from("lsd_users")
      .update(patch)
      .eq("tg_id", tg_id)
      .select("*")
      .single();
    if (e4) throw e4;
    return updated;
  }

  return user;
}

/**
 * Consume quota: "plans" or "media" (decrement by 1), only if not developer/unlimited.
 * Returns fresh user (after update).
 */
async function consumeQuota(tg_id, kind /* "plans" | "media" */) {
  const user = await getOrCreateUserAndFreshen(tg_id);
const tier = effectiveTier(user);
const lim = DAILY_LIMITS[tier];


  const reset = resetInfo(user.quota_next_reset_at);

  if (tier === "developer" || !Number.isFinite(lim[kind])) {
    return { ok: true, user, reset };
  }

  const leftField = kind === "media" ? "media_left" : "plans_left";
  const left = Number.isFinite(user[leftField]) ? user[leftField] : 0;

  if (left <= 0) {
    return {
      ok: false,
      error: kind === "media" ? "no_media_left" : "no_plans_left",
      user,
      reset,
    };
  }

  const { data: updated, error } = await supabase
    .from("lsd_users")
    .update({ [leftField]: left - 1, updated_at: nowISO() })
    .eq("tg_id", tg_id)
    .select("*")
    .single();

  if (error) throw error;
  return { ok: true, user: updated, reset };
}

// -------------------------
// Multer (multipart) — memory storage
// -------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// -------------------------
// Gemini helpers
// -------------------------
async function callGeminiText(prompt) {
  if (!GEMINI_API_KEY) throw new Error("missing_gemini_api_key");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6 },
      }),
    });

    const json = await r.json().catch(() => ({}));

    if (r.ok) {
      return (
        json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || ""
      );
    }

    if (r.status === 429) {
      await sleep(800 * attempt);
      continue;
    }

    throw new Error(json?.error?.message || `gemini_error_${r.status}`);
  }

  return "Сейчас слишком много запросов (лимит API). Попробуй через минуту 🙂";
}

async function callGeminiParts(parts, { temperature = 0.4 } = {}) {
  if (!GEMINI_API_KEY) throw new Error("missing_gemini_api_key");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature },
      }),
    });

    const json = await r.json().catch(() => ({}));

    if (r.ok) {
      return (
        json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || ""
      );
    }

    if (r.status === 429) {
      await sleep(800 * attempt);
      continue;
    }

    throw new Error(json?.error?.message || `gemini_error_${r.status}`);
  }

  return "Сейчас слишком много запросов (лимит API). Попробуй через минуту 🙂";
}

// -------------------------
// Plan JSON extraction
// -------------------------
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

function buildTranscriptFromMessages(msgs) {
  return (msgs || [])
    .map((m) => `${m.role === "assistant" ? "AI" : "User"}: ${safeStr(m.content).trim()}`)
    .filter(Boolean)
    .join("\n");
}

// -------------------------
// DB helpers: chats/messages/tasks
// -------------------------
async function getOrCreateChat(tg_id, chat_id, title = "Чат", emoji = "💬") {
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
    .insert({ tg_id, chat_id, title, emoji, updated_at: nowISO() })
    .select("*")
    .single();

  if (e2) throw e2;
  return created;
}

async function touchChatUpdatedAt(tg_id, chat_id) {
  const { error } = await supabase
    .from("lsd_chats")
    .update({ updated_at: nowISO() })
    .eq("tg_id", tg_id)
    .eq("chat_id", chat_id);

  if (error) throw error;
}

async function insertMessage({ tg_id, chat_id, msg_id, role, content, created_at }) {
  const row = {
    tg_id,
    chat_id,
    role,
    content,
    created_at: created_at || nowISO(),
    ...(msg_id ? { msg_id: safeStr(msg_id) } : {}),
  };

  const { error } = await supabase.from("lsd_messages").insert(row);
  if (error) throw error;
}

async function loadChatMessages({ tg_id, chat_id, limit = 120 }) {
  const { data, error } = await supabase
    .from("lsd_messages")
    .select("role,content,created_at")
    .eq("tg_id", tg_id)
    .eq("chat_id", chat_id)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// sync
async function listChats(tg_id) {
  const { data, error } = await supabase
    .from("lsd_chats")
    .select("chat_id,title,emoji,updated_at")
    .eq("tg_id", tg_id)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) throw error;
  return data || [];
}

async function listMessages(tg_id, sinceISO = null, limit = 4000) {
  let q = supabase
    .from("lsd_messages")
    .select("chat_id,msg_id,role,content,created_at")
    .eq("tg_id", tg_id)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (sinceISO) q = q.gte("created_at", sinceISO);

  const { data, error } = await q;
  if (error) throw error;

  return (data || []).map((m) => ({
    chat_id: m.chat_id,
    msg_id: m.msg_id ?? null,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
  }));
}

async function upsertChats(tg_id, chats) {
  if (!Array.isArray(chats) || chats.length === 0) return;

  const rows = chats
    .map((c) => ({
      tg_id,
      chat_id: safeStr(c.chat_id),
      title: safeStr(c.title) || "Чат",
      emoji: safeStr(c.emoji) || "💬",
      updated_at: safeStr(c.updated_at) || nowISO(),
    }))
    .filter((r) => r.chat_id);

  if (!rows.length) return;

  const { error } = await supabase
    .from("lsd_chats")
    .upsert(rows, { onConflict: "tg_id,chat_id" });

  if (error) throw error;
}

async function upsertMessages(tg_id, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  const withId = [];
  const withoutId = [];

  for (const m of messages) {
    const row = {
      tg_id,
      chat_id: safeStr(m.chat_id),
      msg_id: safeStr(m.msg_id),
      role: safeStr(m.role),
      content: safeStr(m.content),
      created_at: safeStr(m.created_at) || nowISO(),
    };

    const ok =
      row.chat_id &&
      row.role &&
      (row.role === "user" || row.role === "assistant") &&
      row.content;

    if (!ok) continue;

    if (row.msg_id) withId.push(row);
    else
      withoutId.push({
        tg_id,
        chat_id: row.chat_id,
        role: row.role,
        content: row.content,
        created_at: row.created_at,
      });
  }

  if (withId.length) {
    const { error } = await supabase
      .from("lsd_messages")
      .upsert(withId, { onConflict: "tg_id,msg_id" });
    if (error) throw error;
  }

  if (withoutId.length) {
    const { error } = await supabase.from("lsd_messages").insert(withoutId);
    if (error) throw error;
  }
}

// tasks state
async function loadTasksState(tg_id) {
  const { data, error } = await supabase
    .from("lsd_tasks_state")
    .select("state")
    .eq("tg_id", tg_id)
    .maybeSingle();

  if (error) throw error;
  return data?.state || { groups: [] };
}

async function saveTasksState(tg_id, state) {
  const payload = state && typeof state === "object" ? state : { groups: [] };

  const { error } = await supabase
    .from("lsd_tasks_state")
    .upsert({ tg_id, state: payload, updated_at: nowISO() }, { onConflict: "tg_id" });

  if (error) throw error;
}

// -------------------------
// Health
// -------------------------
app.get("/health", (_, res) => res.json({ ok: true, time: nowISO() }));

// -------------------------
// API: USER INIT
// -------------------------
app.post("/api/user/init", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "tg_id_required" });

    const user = await getOrCreateUserAndFreshen(tg_id);
    const tier = tierNorm(user.tier);
    const reset = resetInfo(user.quota_next_reset_at);

    return res.json({
      ok: true,
      tg_id,
      tier,
      plans_left: Number.isFinite(user.plans_left) ? user.plans_left : 0,
      media_left: Number.isFinite(user.media_left) ? user.media_left : 0,
      ...reset,
      server_time: nowISO(),
    });
  } catch (e) {
    console.error("USER INIT ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// -------------------------
// API: CHAT SEND (TEXT) - НЕ тратит лимиты
// -------------------------
app.post("/api/chat/send", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chat_id = safeStr(req.body?.chat_id);
    const text = safeStr(req.body?.text).trim();
    const profile = req.body?.profile || {};
    const user_msg_id = safeStr(req.body?.msg_id) || uuid();

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "tg_id_required" });
    if (!chat_id) return res.status(400).json({ error: "chat_id_required" });
    if (!text) return res.status(400).json({ error: "text_required" });

    const user = await getOrCreateUserAndFreshen(tg_id);
    await getOrCreateChat(tg_id, chat_id, "Чат", "💬");

    await insertMessage({ tg_id, chat_id, msg_id: user_msg_id, role: "user", content: text });
    await touchChatUpdatedAt(tg_id, chat_id);

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

    const answer = await callGeminiText(prompt);

    const ai_msg_id = uuid();
    await insertMessage({ tg_id, chat_id, msg_id: ai_msg_id, role: "assistant", content: answer || "" });
    await touchChatUpdatedAt(tg_id, chat_id);

    const reset = resetInfo(user.quota_next_reset_at);

    return res.json({
      ok: true,
      text: answer || "",
      user_msg_id,
      ai_msg_id,
      tier: effectiveTier(user),
      plans_left: Number.isFinite(user.plans_left) ? user.plans_left : 0,
      media_left: Number.isFinite(user.media_left) ? user.media_left : 0,
      ...reset,
      server_time: nowISO(),
    });
  } catch (e) {
    console.error("CHAT ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// -------------------------
// API: CHAT ATTACH (PHOTO/FILE) - ТРАТИТ MEDIA лимит
// -------------------------
app.post("/api/chat/attach", upload.single("file"), async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chat_id = safeStr(req.body?.chat_id);
    const kind = safeStr(req.body?.kind);

    let profile = {};
    const profileRaw = req.body?.profile;
    if (typeof profileRaw === "string" && profileRaw.trim()) {
      try { profile = JSON.parse(profileRaw); } catch { profile = {}; }
    }

    const file = req.file;

    if (!Number.isFinite(tg_id)) return res.status(400).json({ ok: false, error: "tg_id_required" });
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id_required" });
    if (!file) return res.status(400).json({ ok: false, error: "file_required" });

    // consume media quota (если free/premium)
    const q = await consumeQuota(tg_id, "media");
    if (!q.ok) {
      return res.status(403).json({
        ok: false,
        error: q.error, // no_media_left
        tier: tierNorm(q.user.tier),
        media_left: Number.isFinite(q.user.media_left) ? q.user.media_left : 0,
        plans_left: Number.isFinite(q.user.plans_left) ? q.user.plans_left : 0,
        ...q.reset,
        message_ru: `Лимит медиа на сегодня закончился. Сброс через ${q.reset.quota_reset_in_human} (в ${q.reset.quota_reset_at_local}).`,
      });
    }

    const user = q.user;

    await getOrCreateChat(tg_id, chat_id, "Чат", "💬");

    const label =
      kind === "photo"
        ? `📷 Фото: ${file.originalname || "image"}`
        : `📎 Файл: ${file.originalname || "file"}`;

    const user_msg_id = uuid();
    await insertMessage({ tg_id, chat_id, msg_id: user_msg_id, role: "user", content: label });
    await touchChatUpdatedAt(tg_id, chat_id);

    const msgs = await loadChatMessages({ tg_id, chat_id, limit: 60 });
    const transcript = buildTranscriptFromMessages(msgs);

    const profileBlock = `
Профиль пользователя:
nick: ${profile?.nick || ""}
age: ${profile?.age ?? ""}
bio: ${profile?.bio || ""}
`.trim();

    const isImage = /^image\//i.test(file.mimetype || "");
    let answer = "";

    if (isImage) {
      const base64 = file.buffer.toString("base64");

      const parts = [
        {
          text: `
Ты — LSD (AI Time Manager).
Пользователь отправил изображение. Проанализируй его и помоги.

Правила:
- отвечай на русском
- кратко и по делу
- не создавай JSON-планы

${profileBlock}

История:
${transcript}

Ответь пользователю по изображению.
`.trim(),
        },
        {
          inlineData: { mimeType: file.mimetype || "image/png", data: base64 },
        },
      ];

      answer = await callGeminiParts(parts, { temperature: 0.2 });
    } else {
      answer =
        `Я получил файл "${file.originalname}". ` +
        `Пока умею анализировать только фото/картинки. ` +
        `Если это документ — вставь сюда текст из него.`;
    }

    const ai_msg_id = uuid();
    await insertMessage({ tg_id, chat_id, msg_id: ai_msg_id, role: "assistant", content: answer || "" });
    await touchChatUpdatedAt(tg_id, chat_id);

    return res.json({
      ok: true,
      text: answer || "",
      user_msg_id,
      ai_msg_id,
      tier: effectiveTier(user),
      plans_left: Number.isFinite(user.plans_left) ? user.plans_left : 0,
      media_left: Number.isFinite(user.media_left) ? user.media_left : 0,
      ...q.reset,
      server_time: nowISO(),
      debug: { kind, mimetype: file.mimetype, size: file.size, name: file.originalname },
    });
  } catch (e) {
    console.error("ATTACH ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      details: String(e?.message || e),
    });
  }
});

// -------------------------
// API: PLAN CREATE - ТРАТИТ PLANS лимит (+ сохраняет current_plan)
// -------------------------
app.post("/api/plan/create", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chat_id = safeStr(req.body?.chat_id);
    const profile = req.body?.profile || {};

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "tg_id_required" });
    if (!chat_id) return res.status(400).json({ error: "chat_id_required" });

    // consume plans quota
    const q = await consumeQuota(tg_id, "plans");
    if (!q.ok) {
      return res.status(403).json({
        ok: false,
        error: q.error, // no_plans_left
        tier: tierNorm(q.user.tier),
        plans_left: Number.isFinite(q.user.plans_left) ? q.user.plans_left : 0,
        media_left: Number.isFinite(q.user.media_left) ? q.user.media_left : 0,
        ...q.reset,
        message_ru: `Лимит планов на сегодня закончился. Сброс через ${q.reset.quota_reset_in_human} (в ${q.reset.quota_reset_at_local}).`,
      });
    }

    const user = q.user;
    const tier = tierNorm(user.tier);

    const msgs = await loadChatMessages({ tg_id, chat_id, limit: 140 });
    const transcript = buildTranscriptFromMessages(msgs);
    if (!transcript.trim()) {
      return res.json({
        ok: true,
        cards: [],
        text: "",
        tier,
        plans_left: Number.isFinite(user.plans_left) ? user.plans_left : 0,
        media_left: Number.isFinite(user.media_left) ? user.media_left : 0,
        ...q.reset,
      });
    }

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
- 1–5 карточки
- в каждой карточке 3 задачи
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

    const raw = await callGeminiText(prompt);
    const parsed = extractCards(raw);

    const payload = {
      cards: parsed.ok ? parsed.cards : [],
      text: parsed.cleanText,
      created_at: nowISO(),
      chat_id,
    };

    // сохраняем current_plan (всем)
    await supabase
      .from("lsd_users")
      .update({ current_plan: payload, updated_at: nowISO() })
      .eq("tg_id", tg_id);

    if (!parsed.ok) {
      return res.json({
        ok: true,
        cards: [],
        text: parsed.cleanText,
        tier,
        plans_left: Number.isFinite(user.plans_left) ? user.plans_left : 0,
        media_left: Number.isFinite(user.media_left) ? user.media_left : 0,
        ...q.reset,
        error: "plan_json_invalid",
      });
    }

    return res.json({
      ok: true,
      cards: parsed.cards,
      text: parsed.cleanText,
      tier,
      plans_left: Number.isFinite(user.plans_left) ? user.plans_left : 0,
      media_left: Number.isFinite(user.media_left) ? user.media_left : 0,
      ...q.reset,
    });
  } catch (e) {
    console.error("PLAN ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// -------------------------
// API: SYNC PULL
// -------------------------
app.post("/api/sync/pull", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const since = safeStr(req.body?.since || "");

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "tg_id_required" });

    const user = await getOrCreateUserAndFreshen(tg_id);
    const reset = resetInfo(user.quota_next_reset_at);

    const chats = await listChats(tg_id);
    const messages = await listMessages(tg_id, since || null, 4000);

    let tasks_state = { groups: [] };
    try {
      tasks_state = await loadTasksState(tg_id);
    } catch (e) {
      console.warn("loadTasksState skipped:", e?.message || e);
    }

    return res.json({
      ok: true,
      chats,
      messages,
      tasks_state,
      tier: effectiveTier(user),
      plans_left: Number.isFinite(user.plans_left) ? user.plans_left : 0,
      media_left: Number.isFinite(user.media_left) ? user.media_left : 0,
      ...reset,
      server_time: nowISO(),
    });
  } catch (e) {
    console.error("SYNC PULL ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// -------------------------
// API: SYNC PUSH
// -------------------------
app.post("/api/sync/push", async (req, res) => {
  try {
    const tg_id = Number(req.body?.tg_id);
    const chats_upsert = req.body?.chats_upsert;
    const messages_upsert = req.body?.messages_upsert;
    const tasks_state = req.body?.tasks_state;

    if (!Number.isFinite(tg_id)) return res.status(400).json({ error: "tg_id_required" });

    await getOrCreateUserAndFreshen(tg_id);

    await upsertChats(tg_id, chats_upsert);
    await upsertMessages(tg_id, messages_upsert);

    if (tasks_state) {
      try {
        await saveTasksState(tg_id, tasks_state);
      } catch (e) {
        console.warn("saveTasksState skipped:", e?.message || e);
      }
    }

    return res.json({ ok: true, server_time: nowISO() });
  } catch (e) {
    console.error("SYNC PUSH ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// -------------------------
// OPTIONAL: Background worker (каждые 5 минут сброс всем просроченным)
// Это НЕ обязательно, т.к. "ленивый сброс" уже есть.
// -------------------------
async function resetDueUsersBatch() {
  const now = nowISO();
  const nextReset = nextAlmatyMidnightISO(new Date());

  // free
  {
    const { error } = await supabase
      .from("lsd_users")
      .update({
        plans_left: DAILY_LIMITS.free.plans,
        media_left: DAILY_LIMITS.free.media,
        quota_next_reset_at: nextReset,
        updated_at: now,
      })
      .eq("tier", "free")
      .lte("quota_next_reset_at", now);

    if (error) console.warn("reset batch free error:", error.message || error);
  }

  // premium
  {
    const { error } = await supabase
      .from("lsd_users")
      .update({
        plans_left: DAILY_LIMITS.premium.plans,
        media_left: DAILY_LIMITS.premium.media,
        quota_next_reset_at: nextReset,
        updated_at: now,
      })
      .eq("tier", "premium")
      .lte("quota_next_reset_at", now);

    if (error) console.warn("reset batch premium error:", error.message || error);
  }
}

function startQuotaWorker() {
  resetDueUsersBatch().catch(() => {});
  setInterval(() => {
    resetDueUsersBatch().catch((e) => console.warn("quota worker error:", e?.message || e));
  }, 5 * 60 * 1000);
}

startQuotaWorker();

// -------------------------
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
