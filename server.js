import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import crypto from "crypto";
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
  console.warn("⚠️ GEMINI_API_KEY is missing — /api/chat/send and /api/plan/create will fail.");
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

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------------
// Gemini
// -------------------------
async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("missing_gemini_api_key");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
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
// DB helpers
// -------------------------
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
    .insert({ tg_id, tier: "free", plans_left: 0, updated_at: nowISO() })
    .select("*")
    .single();

  if (e2) throw e2;
  return created;
}

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

// ---- sync tables ----
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

// ---- tasks state (optional table) ----
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

    const user = await getOrCreateUser(tg_id);
    return res.json({
      ok: true,
      tg_id,
      tier: user.tier,
      plans_left: user.plans_left,
      server_time: nowISO(),
    });
  } catch (e) {
    console.error("USER INIT ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// -------------------------
// API: CHAT SEND
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

    const user = await getOrCreateUser(tg_id);

    // IMPORTANT: title берём НЕ из сообщения, иначе чат будет называться каждым новым сообщением
    await getOrCreateChat(tg_id, chat_id, "Чат", "💬");

    // 1) save user message
    await insertMessage({ tg_id, chat_id, msg_id: user_msg_id, role: "user", content: text });
    await touchChatUpdatedAt(tg_id, chat_id);

    // 2) build transcript and call AI
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

    // 3) save assistant message
    const ai_msg_id = uuid();
    await insertMessage({ tg_id, chat_id, msg_id: ai_msg_id, role: "assistant", content: answer || "" });
    await touchChatUpdatedAt(tg_id, chat_id);

    return res.json({
      ok: true,
      text: answer || "",
      user_msg_id,
      ai_msg_id,
      tier: user.tier,
      plans_left: user.plans_left,
      server_time: nowISO(),
    });
  } catch (e) {
    console.error("CHAT ERROR:", e);
    return res.status(500).json({ error: "server_error", details: String(e.message || e) });
  }
});

// -------------------------
// API: PLAN CREATE
// -------------------------
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

    if (tier !== "developer" && plansLeft <= 0) {
      return res.status(403).json({ error: "no_plans_left", tier, plans_left: plansLeft });
    }

    const msgs = await loadChatMessages({ tg_id, chat_id, limit: 140 });
    const transcript = buildTranscriptFromMessages(msgs);
    if (!transcript.trim()) return res.json({ ok: true, cards: [], text: "", tier, plans_left: plansLeft });

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

    const raw = await callGemini(prompt);
    const parsed = extractCards(raw);

    if (!parsed.ok) {
      return res.json({ ok: true, cards: [], text: parsed.cleanText, tier, plans_left: plansLeft, error: "plan_json_invalid" });
    }

    const payload = { cards: parsed.cards, text: parsed.cleanText, created_at: nowISO(), chat_id };

    // developer tier: save without consuming
    if (tier === "developer") {
      await supabase.from("lsd_users").update({ current_plan: payload, updated_at: nowISO() }).eq("tg_id", tg_id);
      return res.json({ ok: true, cards: parsed.cards, text: parsed.cleanText, tier, plans_left: plansLeft });
    }

    // try RPC consume
    let consumed = false;
    try {
      const { data, error } = await supabase.rpc("consume_plan_and_save", {
        p_tg_id: tg_id,
        p_plan: payload,
      });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      consumed = true;

      return res.json({
        ok: true,
        cards: parsed.cards,
        text: parsed.cleanText,
        tier,
        plans_left: row?.plans_left ?? Math.max(plansLeft - 1, 0),
      });
    } catch (e) {
      // fallback: if RPC missing, just store plan and decrement client-visible counter naive
      console.warn("consume_plan_and_save skipped/fallback:", e?.message || e);
    }

    if (!consumed) {
      // fallback save
      const newPlansLeft = Math.max(plansLeft - 1, 0);
      await supabase
        .from("lsd_users")
        .update({ current_plan: payload, plans_left: newPlansLeft, updated_at: nowISO() })
        .eq("tg_id", tg_id);

      return res.json({ ok: true, cards: parsed.cards, text: parsed.cleanText, tier, plans_left: newPlansLeft, warning: "rpc_missing_fallback_used" });
    }
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

    await getOrCreateUser(tg_id);

    const chats = await listChats(tg_id);
    const messages = await listMessages(tg_id, since || null, 4000);

    let tasks_state = { groups: [] };
    try {
      tasks_state = await loadTasksState(tg_id);
    } catch (e) {
      // if table doesn't exist — don't break sync
      console.warn("loadTasksState skipped:", e?.message || e);
    }

    return res.json({
      ok: true,
      chats,
      messages,
      tasks_state,
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

    await getOrCreateUser(tg_id);

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
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
