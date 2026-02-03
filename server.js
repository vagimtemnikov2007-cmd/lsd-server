// LSD Front — FULL (Chats + Plan Accept/Decline + Grouped Tasks + Points synced with DB)

window.addEventListener("DOMContentLoaded", () => {
  // =========================
  // SAFE STORAGE (Telegram WebView fix)
  // =========================
  const memStore = new Map();

  function sGet(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      if (v === null) return memStore.has(key) ? memStore.get(key) : fallback;
      return v;
    } catch {
      return memStore.has(key) ? memStore.get(key) : fallback;
    }
  }

  function sSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      memStore.set(key, value);
    }
  }

  function sJSONGet(key, fallback) {
    const raw = sGet(key, null);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function sJSONSet(key, obj) {
    sSet(key, JSON.stringify(obj));
  }

  // =========================
  // HELPERS
  // =========================
  const $ = (id) => document.getElementById(id);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  const debugLine = $("debugLine");
  const dbg = (msg) => {
    if (debugLine) debugLine.textContent = String(msg);
  };

  const escapeHTML = (s) =>
    String(s).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[ch]));

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function uuid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function getTgIdOrNull() {
    const tg = window.Telegram?.WebApp;
    const id = tg?.initDataUnsafe?.user?.id;
    const n = Number(id);
    return Number.isFinite(n) ? n : null;
  }

  // =========================
  // CONFIG / STORAGE KEYS
  // =========================
  const API_BASE = "https://lsd-server-ml3z.onrender.com";

  const STORAGE_PROFILE = "lsd_profile_v2";

  const STORAGE_ACTIVE_CHAT = "lsd_active_chat_v3";
  const STORAGE_CHATS_INDEX = "lsd_chats_index_v1";
  const STORAGE_CHAT_CACHE = "lsd_chat_cache_v3";

  const STORAGE_TASKS_GROUPS = "lsd_tasks_groups_v2"; // { groups: [...] }

  const STORAGE_POINTS = "lsd_points_v1"; // cached
  let points = Number(sGet(STORAGE_POINTS, "0")) || 0;

  function savePointsCache() {
    sSet(STORAGE_POINTS, String(points));
    renderPointsBar();
  }

  const EMOJIS = ["💬","🧠","⚡","🧩","📌","🎯","🧊","🍀","🌙","☀️","🦊","🐺","🐼","🧪","📚"];
  function pickEmoji() { return EMOJIS[(Math.random() * EMOJIS.length) | 0]; }

  // =========================
  // NETWORK (timeout)
  // =========================
  async function postJSON(url, payload, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      dbg("➡️ " + url);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = await res.text();

      let data = null;
      try { data = raw ? JSON.parse(raw) : null; }
      catch { data = { error: "bad_json_from_server", raw }; }

      dbg(`⬅️ status=${res.status} ok=${res.ok}`);
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      const msg = e?.name === "AbortError" ? `timeout_${timeoutMs}ms` : String(e?.message || e);
      dbg("❌ fetch error: " + msg);
      return { ok: false, status: 0, data: { error: msg } };
    } finally {
      clearTimeout(timer);
    }
  }

  // =========================
  // ELEMENTS
  // =========================
  const settingsBtn = document.querySelector(".settings_bt");
  const drawer = $("settingsDrawer");
  const drawerOverlay = $("drawerOverlay");

  const screenHome = $("screen-home");
  const screenTasks = $("screen-tasks");
  const screenChat = $("screen-chat");

  const navBtn = $("navBtn");
  const navBtnText = navBtn?.querySelector("span");

  const promptEl = $("prompt");
  const sendBtn = $("sendBtn");
  const chatMessagesEl = $("chatMessages");
  const chatTypingEl = $("chatTyping");

  const planBtn = $("planBtn");
  const userEl = $("user");

  const drawerName = $("drawerName");
  const drawerPhone = $("drawerPhone");
  const drawerAvatar = $("drawerAvatar");

  const themeMiniBtn = $("themeMiniBtn");
  const menuProfile = $("menuProfile");
  const menuHistory = $("menuHistory");
  const menuSettings = $("menuSettings");

  const historyList = $("historyList");
  const clearHistoryBtn = $("clearHistory");

  const profileModal = $("profileModal");
  const profileOverlay = $("profileOverlay");
  const closeProfileBtn = $("closeProfile");

  const profileName = $("profileName");
  const profileAge = $("profileAge");
  const profileNick = $("profileNick");
  const profileBio = $("profileBio");

  const planOverlay = $("planOverlay");
  const planModal = $("planModal");
  const planContent = $("planContent");
  const closePlanBtn = $("closePlan");

  const tasksListEl = $("tasksList");
  const clearTasksBtn = $("clearTasks");

  // =========================
  // STATE
  // =========================
  let currentScreen = "home";
  let isLoading = false;

  let activeChatId = sGet(STORAGE_ACTIVE_CHAT, "");
  let chatsIndex = sJSONGet(STORAGE_CHATS_INDEX, []);
  let chatCache = sJSONGet(STORAGE_CHAT_CACHE, {});
  let tasksState = sJSONGet(STORAGE_TASKS_GROUPS, { groups: [] });

  // =========================
  // POINTS BAR (UI)
  // =========================
  let pointsBarEl = null;

  function ensurePointsBar() {
    if (!screenTasks) return;
    if (pointsBarEl && pointsBarEl.isConnected) return;

    pointsBarEl = document.createElement("div");
    pointsBarEl.id = "pointsBar";
    pointsBarEl.style.cssText = `
      display:flex; align-items:center; justify-content:space-between;
      padding:10px 12px; margin:0 0 10px 0;
      border-radius:14px;
      background: rgba(255,255,255,0.78);
      backdrop-filter: blur(10px);
      box-shadow: 0 10px 24px rgba(0,0,0,0.08);
      gap:10px;
    `;

    pointsBarEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="
          width:40px; height:40px; border-radius:12px;
          display:flex; align-items:center; justify-content:center;
          background: rgba(0,0,0,0.06);
          font-size:20px;
        ">🏆</div>
        <div>
          <div style="font-weight:700; font-size:14px; line-height:1.1;">Очки</div>
          <div id="pointsValue" style="opacity:.75; font-size:13px;">0</div>
        </div>
      </div>
      <button id="pointsSyncBtn" type="button" style="
        border:0; border-radius:12px; padding:10px 12px;
        background: rgba(53,166,211,0.16);
        font-weight:700;
      ">Обновить</button>
    `;

    // вставим сверху в tasks screen (перед списком)
    const host = screenTasks.querySelector(".card") || screenTasks;
    host.insertBefore(pointsBarEl, host.firstChild);

    const btn = $("pointsSyncBtn");
    on(btn, "click", () => syncPull(true));
  }

  function renderPointsBar() {
    ensurePointsBar();
    const v = $("pointsValue");
    if (v) v.textContent = String(points || 0);
  }

  // =========================
  // SYNC PUSH (debounced)
  // =========================
  let syncTimer = null;
  function scheduleSyncPush() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncPush, 650);
  }

  function roleToWho(role) { return role === "assistant" ? "ai" : "user"; }
  function whoToRole(who) { return who === "ai" ? "assistant" : "user"; }

  async function syncPush() {
    const tg_id = getTgIdOrNull();
    if (!tg_id) return;

    // chats
    const chats_upsert = (chatsIndex || [])
      .filter((id) => chatCache[id])
      .map((id) => {
        const c = chatCache[id];
        return {
          chat_id: id,
          title: c?.meta?.title || "Новый чат",
          emoji: c?.meta?.emoji || "💬",
          updated_at: new Date(c?.meta?.updatedAt || Date.now()).toISOString(),
        };
      });

    // messages (last 80 per chat)
    const messages_upsert = [];
    (chatsIndex || []).forEach((chat_id) => {
      const arr = (chatCache[chat_id]?.messages || []).slice(-80);
      arr.forEach((m) => {
        if (!m.msg_id) m.msg_id = uuid();
        messages_upsert.push({
          chat_id,
          msg_id: m.msg_id,
          role: whoToRole(m.who),
          content: m.text,
          created_at: new Date(m.ts || Date.now()).toISOString(),
        });
      });
    });

    const { ok, data } = await postJSON(`${API_BASE}/api/sync/push`, {
      tg_id,
      chats_upsert,
      messages_upsert,
      tasks_state: tasksState,
      points, // ✅ points synced with DB
    });

    // если сервер вернул “истину”
    if (ok && Number.isFinite(Number(data?.points))) {
      points = Number(data.points);
      savePointsCache();
    }
  }

  // =========================
  // UI: SCREEN SWITCH
  // =========================
  function setNavLabel() {
    if (!navBtnText) return;
    navBtnText.textContent = currentScreen === "home" ? "задачи" : "назад";
  }

  function scrollToBottom() {
    if (!chatMessagesEl) return;
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function updatePlanVisibility() {
    if (!planBtn) return;
    const enough = getMessages().length >= 2;
    planBtn.hidden = !(currentScreen === "chat" && enough);
  }

  function switchScreen(name) {
    if (currentScreen === "chat" && name !== "chat") cleanupEmptyChats();

    [screenHome, screenTasks, screenChat].forEach((s) => s && s.classList.remove("active"));
    const el = name === "home" ? screenHome : name === "tasks" ? screenTasks : screenChat;
    el && el.classList.add("active");

    currentScreen = name;
    setNavLabel();
    updatePlanVisibility();

    if (name === "tasks") {
      ensurePointsBar();
      renderPointsBar();
    }

    if (name === "chat") scrollToBottom();
  }

  on(navBtn, "click", () => {
    if (currentScreen === "home") switchScreen("tasks");
    else switchScreen("home");
  });

  // =========================
  // PROFILE
  // =========================
  function loadProfile() {
    return sJSONGet(STORAGE_PROFILE, { age: "", nick: "", bio: "" });
  }
  function saveProfile(p) { sJSONSet(STORAGE_PROFILE, p); }

  function openProfile() {
    if (!profileModal || !profileOverlay) return;
    profileModal.classList.add("open");
    profileOverlay.classList.add("open");
    profileModal.setAttribute("aria-hidden", "false");
  }
  function closeProfile() {
    if (!profileModal || !profileOverlay) return;
    profileModal.classList.remove("open");
    profileOverlay.classList.remove("open");
    profileModal.setAttribute("aria-hidden", "true");
  }

  // =========================
  // THEME
  // =========================
  function syncThemeIcon() {
    const isDark = document.body.classList.contains("dark");
    if (themeMiniBtn) themeMiniBtn.textContent = isDark ? "☀️" : "🌙";
  }
  on(themeMiniBtn, "click", () => {
    document.body.classList.toggle("dark");
    syncThemeIcon();
  });

  // =========================
  // DRAWER OPEN/CLOSE
  // =========================
  function openDrawer() {
    drawer?.classList.add("open");
    drawerOverlay?.classList.add("open");
    drawer?.setAttribute("aria-hidden", "false");
    renderChatsInHistory();
  }
  function closeDrawer() {
    drawer?.classList.remove("open");
    drawerOverlay?.classList.remove("open");
    drawer?.setAttribute("aria-hidden", "true");
  }
  on(settingsBtn, "click", openDrawer);
  on(drawerOverlay, "click", closeDrawer);

  // =========================
  // CHATS STORAGE
  // =========================
  function ensureChat(id) {
    if (!id) return;
    if (!chatCache[id]) {
      chatCache[id] = { meta: { title: "Новый чат", emoji: pickEmoji(), updatedAt: Date.now() }, messages: [] };
      return;
    }
    if (!chatCache[id].meta) chatCache[id].meta = { title: "Новый чат", emoji: pickEmoji(), updatedAt: Date.now() };
    if (!Array.isArray(chatCache[id].messages)) chatCache[id].messages = [];
    if (!chatCache[id].meta.updatedAt) chatCache[id].meta.updatedAt = Date.now();
    if (!chatCache[id].meta.emoji) chatCache[id].meta.emoji = pickEmoji();
    if (!chatCache[id].meta.title) chatCache[id].meta.title = "Новый чат";
  }

  function saveChats() {
    sSet(STORAGE_ACTIVE_CHAT, activeChatId);
    sJSONSet(STORAGE_CHATS_INDEX, chatsIndex);
    sJSONSet(STORAGE_CHAT_CACHE, chatCache);
  }

  function bumpChatToTop(id) {
    chatsIndex = [id, ...chatsIndex.filter((x) => x !== id)];
  }

  function getActiveChat() {
    ensureChat(activeChatId);
    return chatCache[activeChatId];
  }

  function getMessages() {
    if (!activeChatId) return [];
    return getActiveChat().messages || [];
  }

  function makeChatTitleFromText(text) {
    const t = String(text || "").trim();
    if (!t) return "Новый чат";
    return t.length > 22 ? t.slice(0, 22) + "…" : t;
  }

  function cleanupEmptyChats() {
    const userIsInChatNow = (currentScreen === "chat");

    const toDelete = chatsIndex.filter((id) => {
      ensureChat(id);
      const c = chatCache[id];
      const empty = !c.messages || c.messages.length === 0;
      const isActive = id === activeChatId;
      return empty && (!isActive || !userIsInChatNow);
    });

    if (!toDelete.length) return;

    toDelete.forEach((id) => delete chatCache[id]);
    chatsIndex = chatsIndex.filter((id) => !toDelete.includes(id));

    if (toDelete.includes(activeChatId)) activeChatId = chatsIndex[0] || "";

    if (!activeChatId) {
      const id = uuid();
      chatCache[id] = { meta: { title: "Новый чат", emoji: pickEmoji(), updatedAt: Date.now() }, messages: [] };
      chatsIndex = [id];
      activeChatId = id;
    }

    saveChats();
    renderChatsInHistory();
  }

  function setActiveChat(id) {
    cleanupEmptyChats();
    activeChatId = id;
    ensureChat(activeChatId);

    if (!chatsIndex.includes(activeChatId)) chatsIndex.unshift(activeChatId);
    bumpChatToTop(activeChatId);
    saveChats();

    renderMessages();
    renderChatsInHistory();
  }

  function createNewChat() {
    cleanupEmptyChats();
    const id = uuid();
    chatCache[id] = { meta: { title: "Новый чат", emoji: pickEmoji(), updatedAt: Date.now() }, messages: [] };
    chatsIndex = [id, ...chatsIndex.filter((x) => x !== id)];
    setActiveChat(id);
  }

  function resetAllChats() {
    chatCache = {};
    chatsIndex = [];
    activeChatId = "";
    saveChats();
    createNewChat();
  }

  function pushMsg(who, text) {
    if (!activeChatId) createNewChat();

    const c = getActiveChat();
    const msg = { msg_id: uuid(), who, text: String(text ?? ""), ts: Date.now() };
    c.messages.push(msg);

    c.meta.updatedAt = Date.now();
    if (c.meta.title === "Новый чат" && who === "user") c.meta.title = makeChatTitleFromText(text);

    bumpChatToTop(activeChatId);
    saveChats();

    renderMessages();
    renderChatsInHistory();

    scheduleSyncPush();
  }

  // =========================
  // RENDER MESSAGES
  // =========================
  function renderMessages() {
    if (!chatMessagesEl) return;
    chatMessagesEl.innerHTML = "";

    const arr = getMessages();
    arr.forEach((m) => {
      const div = document.createElement("div");
      div.className = "msg " + (m.who === "user" ? "user" : "ai");
      div.textContent = m.text;
      chatMessagesEl.appendChild(div);
    });

    scrollToBottom();
    updatePlanVisibility();
  }

  // =========================
  // RENDER CHATS LIST (drawer)
  // =========================
  function renderChatsInHistory() {
    if (!historyList) return;
    historyList.innerHTML = "";

    const newRow = document.createElement("div");
    newRow.className = "tgChatRow";
    newRow.innerHTML = `
      <div class="tgEmojiAvatar">➕</div>
      <div class="tgChatMid">
        <div class="tgChatTitle">Новый чат</div>
        <div class="tgChatLast">Создать новый диалог</div>
      </div>
      <div class="tgChatRight"><div class="tgChatTime"></div></div>
    `;
    newRow.addEventListener("click", () => {
      createNewChat();
      closeDrawer();
      switchScreen("chat");
    });
    historyList.appendChild(newRow);

    if (!chatsIndex.length) {
      const empty = document.createElement("div");
      empty.className = "histMsg ai";
      empty.textContent = "История чатов пустая 🙂";
      historyList.appendChild(empty);
      return;
    }

    chatsIndex.forEach((id) => {
      ensureChat(id);
      const c = chatCache[id];
      const last = c.messages[c.messages.length - 1];

      const row = document.createElement("div");
      row.className = "tgChatRow";
      if (id === activeChatId) row.style.background = "rgba(0,0,0,0.03)";

      row.innerHTML = `
        <div class="tgEmojiAvatar">${c.meta.emoji || "💬"}</div>
        <div class="tgChatMid">
          <div class="tgChatTitle">${escapeHTML(c.meta.title || "Новый чат")}</div>
          <div class="tgChatLast">${escapeHTML(last ? last.text : "Пусто…")}</div>
        </div>
        <div class="tgChatRight">
          <div class="tgChatTime">${fmtTime(c.meta.updatedAt || Date.now())}</div>
        </div>
      `;

      row.addEventListener("click", () => {
        setActiveChat(id);
        closeDrawer();
        switchScreen("chat");
      });

      historyList.appendChild(row);
    });
  }

  // =========================
  // TASKS (Grouped) + CLAIM
  // =========================
  function saveTasksState() {
    sJSONSet(STORAGE_TASKS_GROUPS, tasksState);
  }

  function energyToLevel(energy) {
    const e = String(energy || "").toLowerCase();
    if (!e) return 2;
    if (e.includes("low") || e.includes("легк") || e.includes("easy")) return 1;
    if (e.includes("high") || e.includes("тяж") || e.includes("hard")) return 3;
    if (e.includes("med") || e.includes("сред")) return 2;
    const bolts = (String(energy).match(/⚡/g) || []).length;
    if (bolts) return clamp(bolts, 1, 3);
    return 2;
  }

  function levelLabel(level) {
    if (level <= 1) return "Лёгкая";
    if (level === 2) return "Средняя";
    return "Сложная";
  }

  function groupMeta(group) {
    const items = Array.isArray(group.items) ? group.items : [];
    const totalMin = items.reduce((s, t) => s + (Number.isFinite(Number(t.min)) ? Number(t.min) : 0), 0);
    const avgLevel = items.length
      ? Math.round(items.reduce((s, t) => s + (Number(t.level) || 2), 0) / items.length)
      : 2;

    const doneCount = items.filter((t) => !!t.done).length;
    const allDone = items.length > 0 && doneCount === items.length;

    return { totalMin, avgLevel, doneCount, allDone, totalCount: items.length };
  }

  function calcAwardPoints(group) {
    // красиво и “ощутимо”, но не ломает ничего:
    // 10 очков за задачу + 1 очко за каждые 5 минут суммарно
    const meta = groupMeta(group);
    const perTask = meta.totalCount * 10;
    const perMin = Math.floor((meta.totalMin || 0) / 5);
    return perTask + perMin;
  }

  function renderTasks() {
    if (!tasksListEl) return;

    ensurePointsBar();
    renderPointsBar();

    const groups = Array.isArray(tasksState?.groups) ? tasksState.groups : [];
    tasksListEl.innerHTML = "";

    if (!groups.length) {
      const li = document.createElement("li");
      li.className = "taskItem";
      li.innerHTML = `<div class="taskText">Задач пока нет 🙂</div>`;
      tasksListEl.appendChild(li);
      return;
    }

    groups.forEach((g) => {
      const meta = groupMeta(g);
      const open = !!g.open;

      const wrap = document.createElement("li");
      wrap.className = "taskGroup";
      wrap.dataset.groupId = g.id;

      const claimed = !!g.claimed;

      wrap.innerHTML = `
        <div class="taskGroupHead ${open ? "open" : ""}" style="display:flex; align-items:center; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div class="taskGroupTitle" style="white-space:normal; line-height:1.15;">
              ${escapeHTML(g.title || "План")}
            </div>
            <div class="taskGroupMeta" style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap;">
              <span class="metaPill">⏱ ${meta.totalMin || 0}м</span>
              <span class="metaPill">⚡ ${levelLabel(meta.avgLevel)}</span>
              <span class="metaPill">✅ ${meta.doneCount}/${meta.totalCount}</span>
              ${claimed ? `<span class="metaPill">🏆 Сдано</span>` : ``}
            </div>
          </div>

          ${
            !claimed && meta.allDone
              ? `<button class="claimBtn" type="button" style="
                  border:0; border-radius:12px; padding:10px 12px;
                  font-weight:800; white-space:nowrap;
                  background: rgba(34,197,94,0.18);
                ">Сдать</button>`
              : ``
          }

          <div class="taskGroupChevron" style="margin-left:6px;">${open ? "▾" : "▸"}</div>
        </div>

        <div class="taskGroupBody ${open ? "open" : ""}"></div>
      `;

      const head = wrap.querySelector(".taskGroupHead");
      const body = wrap.querySelector(".taskGroupBody");
      const claimBtn = wrap.querySelector(".claimBtn");

      // раскрытие/сворачивание — по клику на HEAD, но не мешаем кнопке “Сдать”
      head.addEventListener("click", (e) => {
        if (e.target?.classList?.contains("claimBtn")) return;
        g.open = !g.open;
        saveTasksState();
        renderTasks();
      });

      if (claimBtn) {
        claimBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();

          // начисляем очки
          const add = calcAwardPoints(g);
          points = (Number(points) || 0) + add;
          g.claimed = true;

          saveTasksState();
          savePointsCache();

          // пушим в БД
          scheduleSyncPush();

          // чуть “кайф” — покажем в дебаге
          dbg(`🏆 +${add} очков (итого ${points})`);
          renderTasks();
        });
      }

      const items = Array.isArray(g.items) ? g.items : [];
      if (!items.length) {
        body.innerHTML = `<div class="taskGroupEmpty">Пусто…</div>`;
      } else {
        items.forEach((t) => {
          const row = document.createElement("div");
          row.className = "taskRow" + (t.done ? " done" : "");

          // делаем так, чтобы текст нормально переносился
          row.innerHTML = `
            <label class="taskRowLeft" style="display:flex; gap:10px; align-items:flex-start; flex:1; min-width:0;">
              <input type="checkbox" ${t.done ? "checked" : ""} style="margin-top:4px;" />
              <span class="taskRowText" style="white-space:normal; word-break:break-word; line-height:1.2;">
                ${escapeHTML(t.text || "")}
              </span>
            </label>
            <div class="taskRowRight" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
              ${Number.isFinite(Number(t.min)) ? `<span class="miniMeta">⏱ ${Number(t.min)}м</span>` : ""}
              <span class="miniMeta">⚡ ${levelLabel(Number(t.level) || 2)}</span>
            </div>
          `;

          const cb = row.querySelector("input[type='checkbox']");
          cb.addEventListener("change", () => {
            t.done = !!cb.checked;
            saveTasksState();
            renderTasks();
            scheduleSyncPush();
          });

          body.appendChild(row);
        });
      }

      tasksListEl.appendChild(wrap);
    });
  }

  function clearAllTasks() {
    tasksState = { groups: [] };
    saveTasksState();
    renderTasks();
    scheduleSyncPush();
  }
  on(clearTasksBtn, "click", clearAllTasks);

  // =========================
  // PLAN MODAL (Accept / Decline)
  // =========================
  function openPlanModal(htmlOrNode) {
    if (!planOverlay || !planModal || !planContent) return;

    if (typeof htmlOrNode === "string") {
      planContent.innerHTML = htmlOrNode;
    } else {
      planContent.innerHTML = "";
      planContent.appendChild(htmlOrNode);
    }

    planOverlay.classList.add("open");
    planModal.classList.add("open");
  }

  function closePlanModal() {
    planOverlay?.classList.remove("open");
    planModal?.classList.remove("open");
  }

  on(closePlanBtn, "click", closePlanModal);
  on(planOverlay, "click", closePlanModal);

  function normalizeCards(cards) {
    const arr = Array.isArray(cards) ? cards : [];
    return arr.map((c, idx) => {
      const title = String(c?.title || `План #${idx + 1}`).trim();
      const tasks = Array.isArray(c?.tasks) ? c.tasks : [];

      const items = tasks
        .map((t) => {
          const text = String(t?.t || "").trim();
          if (!text) return null;

          const min = Number.isFinite(Number(t?.min)) ? Number(t.min) : null;
          const level = energyToLevel(t?.energy);

          return { id: uuid(), text, min, level, done: false };
        })
        .filter(Boolean);

      return { id: uuid(), title, items };
    });
  }

  function addGroupToTasks(group) {
    if (!group?.items?.length) return;

    const existing = Array.isArray(tasksState.groups) ? tasksState.groups : [];
    const same = existing.find((g) => String(g.title) === String(group.title));

    if (same) {
      same.items = [...same.items, ...group.items];
      same.open = true;
    } else {
      tasksState.groups.unshift({
        id: uuid(),
        title: group.title,
        items: group.items,
        open: true,
        createdAt: Date.now(),
        claimed: false,
      });
    }

    saveTasksState();
    renderTasks();
    scheduleSyncPush();
  }

  function renderPlanForAccept(cardsNormalized) {
    const wrap = document.createElement("div");
    wrap.className = "planCards";

    cardsNormalized.forEach((g) => {
      const meta = groupMeta(g);

      const card = document.createElement("div");
      card.className = "planCard";

      card.innerHTML = `
        <div class="planCardHead">
          <div class="planCardTitle">${escapeHTML(g.title)}</div>
          <div class="planCardMeta">
            <span class="metaPill">⏱ ${meta.totalMin || 0}м</span>
            <span class="metaPill">⚡ ${levelLabel(meta.avgLevel)}</span>
          </div>
        </div>

        <div class="planCardBody"></div>

        <div class="planCardActions">
          <button class="planAcceptBtn" type="button">Принять</button>
          <button class="planDeclineBtn" type="button">Отклонить</button>
        </div>
      `;

      const body = card.querySelector(".planCardBody");

      if (!g.items.length) {
        body.innerHTML = `<div class="planEmpty">Пусто…</div>`;
      } else {
        g.items.forEach((t) => {
          const row = document.createElement("div");
          row.className = "planTaskRow";
          row.innerHTML = `
            <div class="planTaskText">${escapeHTML(t.text)}</div>
            <div class="planTaskMeta">
              ${Number.isFinite(Number(t.min)) ? `<span>⏱ ${Number(t.min)}м</span>` : ""}
              <span>⚡ ${levelLabel(Number(t.level) || 2)}</span>
            </div>
          `;
          body.appendChild(row);
        });
      }

      const acceptBtn = card.querySelector(".planAcceptBtn");
      const declineBtn = card.querySelector(".planDeclineBtn");

      acceptBtn.addEventListener("click", () => {
        addGroupToTasks(g);
        card.remove();
        const left = wrap.querySelectorAll(".planCard").length;
        if (!left) {
          closePlanModal();
          switchScreen("tasks");
        }
      });

      declineBtn.addEventListener("click", () => {
        card.remove();
        const left = wrap.querySelectorAll(".planCard").length;
        if (!left) closePlanModal();
      });

      wrap.appendChild(card);
    });

    return wrap;
  }

  async function createPlan() {
    if (isLoading) return;

    const tg_id = getTgIdOrNull();
    if (!tg_id) {
      dbg("❌ Открой внутри Telegram (нет tg_id)");
      return;
    }
    if (getMessages().length < 2) {
      dbg("🙂 Мало переписки для плана");
      return;
    }

    isLoading = true;
    if (planBtn) planBtn.disabled = true;

    try {
      dbg("Создаю план…");

      const profile = loadProfile();
      const { ok, status, data } = await postJSON(`${API_BASE}/api/plan/create`, {
        tg_id,
        chat_id: activeChatId,
        profile,
      });

      if (!ok) {
        openPlanModal(`<div class="planError">Ошибка: ${escapeHTML(data?.error || `status_${status}`)}</div>`);
        return;
      }

      const cards = Array.isArray(data?.cards) ? data.cards : [];
      if (!cards.length) {
        openPlanModal(`<div class="planEmpty">План пустой. Напиши больше деталей 🙂</div>`);
        return;
      }

      const normalized = normalizeCards(cards);
      openPlanModal(renderPlanForAccept(normalized));
    } catch (e) {
      openPlanModal(`<div class="planError">Не удалось подключиться к серверу.</div>`);
    } finally {
      isLoading = false;
      if (planBtn) planBtn.disabled = false;
    }
  }

  // =========================
  // SEND MESSAGE
  // =========================
  async function sendMessage() {
    if (isLoading) return;

    const text = (promptEl?.value || "").trim();
    if (!text) return;

    switchScreen("chat");
    pushMsg("user", text);

    if (promptEl) promptEl.value = "";

    const tg_id = getTgIdOrNull();
    if (!tg_id) {
      pushMsg("ai", "Открой мини-апп внутри Telegram, иначе tg_id не приходит.");
      return;
    }

    isLoading = true;
    if (sendBtn) sendBtn.disabled = true;
    if (chatTypingEl) chatTypingEl.hidden = false;

    try {
      const profile = loadProfile();
      const last = getMessages().slice(-1)[0];
      const msg_id = last?.msg_id;

      const { ok, status, data } = await postJSON(`${API_BASE}/api/chat/send`, {
        tg_id,
        chat_id: activeChatId,
        text,
        profile,
        msg_id,
      });

      if (!ok) {
        pushMsg("ai", "Ошибка сервера: " + (data?.error || `status_${status}`));
        return;
      }

      // если сервер вернул points — обновим
      if (Number.isFinite(Number(data?.points))) {
        points = Number(data.points);
        savePointsCache();
      }

      pushMsg("ai", String(data?.text || "").trim() || "AI вернул пустой ответ 😶");
    } catch (e) {
      pushMsg("ai", "Не удалось подключиться к серверу.");
    } finally {
      isLoading = false;
      if (sendBtn) sendBtn.disabled = false;
      if (chatTypingEl) chatTypingEl.hidden = true;
    }
  }

  // =========================
  // INIT USER IN DB
  // =========================
  async function initUserInDB() {
    const tg_id = getTgIdOrNull();
    if (!tg_id) return;

    try {
      const profile = loadProfile();
      const { ok, data } = await postJSON(`${API_BASE}/api/user/init`, { tg_id, profile });

      if (ok && Number.isFinite(Number(data?.points))) {
        points = Number(data.points);
        savePointsCache();
      }
    } catch {}
  }

  // =========================
  // SYNC PULL (fetch chats/messages/tasks/points)
  // =========================
  async function syncPull(force = false) {
    const tg_id = getTgIdOrNull();
    if (!tg_id) return;

    const { ok, data } = await postJSON(`${API_BASE}/api/sync/pull`, { tg_id });
    if (!ok) return;

    // points from DB
    if (Number.isFinite(Number(data?.points))) {
      points = Number(data.points);
      savePointsCache();
    }

    // chats
    if (Array.isArray(data?.chats)) {
      data.chats.forEach((c) => {
        const id = c.chat_id;
        if (!id) return;

        if (!chatCache[id]) chatCache[id] = { meta: {}, messages: [] };
        chatCache[id].meta = {
          title: c.title || "Новый чат",
          emoji: c.emoji || "💬",
          updatedAt: new Date(c.updated_at || Date.now()).getTime(),
        };

        if (!chatsIndex.includes(id)) chatsIndex.push(id);
        ensureChat(id);
      });
    }

    // messages
    if (Array.isArray(data?.messages)) {
      const byChat = new Map();

      data.messages.forEach((m) => {
        const chat_id = m.chat_id;
        if (!chat_id) return;

        if (!byChat.has(chat_id)) byChat.set(chat_id, []);
        byChat.get(chat_id).push({
          msg_id: m.msg_id || uuid(),
          who: roleToWho(m.role),
          text: m.content,
          ts: new Date(m.created_at || Date.now()).getTime(),
        });
      });

      byChat.forEach((arr, chat_id) => {
        ensureChat(chat_id);

        const existing = new Set(
          (chatCache[chat_id].messages || []).map((x) => x.msg_id).filter(Boolean)
        );

        arr.forEach((x) => {
          if (!existing.has(x.msg_id)) chatCache[chat_id].messages.push(x);
        });

        chatCache[chat_id].messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));

        const last = chatCache[chat_id].messages[chatCache[chat_id].messages.length - 1];
        if (last?.ts) chatCache[chat_id].meta.updatedAt = last.ts;
      });
    }

    // tasks_state
    if (data?.tasks_state && typeof data.tasks_state === "object") {
      tasksState = data.tasks_state;
      saveTasksState();
    }

    // sort chats
    chatsIndex = chatsIndex
      .filter((id) => chatCache[id])
      .sort((a, b) => (chatCache[b].meta.updatedAt || 0) - (chatCache[a].meta.updatedAt || 0));

    if (!activeChatId || !chatCache[activeChatId]) {
      activeChatId = chatsIndex[0] || activeChatId;
    }

    saveChats();
    renderTasks();
    renderChatsInHistory();
    renderMessages();
  }

  // =========================
  // DRAWER USER INFO INIT
  // =========================
  function initDrawerUser() {
    const tg = window.Telegram?.WebApp;
    const u = tg?.initDataUnsafe?.user;

    if (drawerName) drawerName.textContent = u?.first_name ? u.first_name : "User";
    if (drawerPhone) drawerPhone.textContent = u?.id ? `ID: ${u.id}` : "ID: —";
    if (drawerAvatar && u?.photo_url) drawerAvatar.src = u.photo_url;

    if (profileName) profileName.value = u?.first_name ? u.first_name : "User";

    const p = loadProfile();
    if (profileAge) profileAge.value = p.age ?? "";
    if (profileNick) profileNick.value = p.nick ?? "";
    if (profileBio) profileBio.value = p.bio ?? "";

    syncThemeIcon();
  }

  // =========================
  // MENU + PROFILE SAVE
  // =========================
  on(menuProfile, "click", () => { closeDrawer(); openProfile(); });
  on(menuHistory, "click", () => { historyList?.scrollTo({ top: 0, behavior: "smooth" }); });
  on(menuSettings, "click", () => {});
  on(clearHistoryBtn, "click", () => { resetAllChats(); renderChatsInHistory(); });

  function saveProfileAndClose() {
    const p = { age: profileAge?.value ?? "", nick: profileNick?.value ?? "", bio: profileBio?.value ?? "" };
    saveProfile(p);
    closeProfile();
    initUserInDB();
    syncPull(true);
  }
  on(closeProfileBtn, "click", saveProfileAndClose);
  on(profileOverlay, "click", saveProfileAndClose);

  // =========================
  // BINDINGS
  // =========================
  on(sendBtn, "click", sendMessage);
  on(promptEl, "keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  on(planBtn, "click", createPlan);

  // =========================
  // TELEGRAM INIT
  // =========================
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();

    const u = tg.initDataUnsafe?.user;
    if (userEl) userEl.textContent = "Привет, " + (u?.first_name || "друг");
    initUserInDB();
  } else {
    if (userEl) userEl.textContent = "Открой внутри Telegram WebApp 🙂";
  }

  // =========================
  // BOOT
  // =========================
  if (!activeChatId) {
    if (Array.isArray(chatsIndex) && chatsIndex.length) activeChatId = chatsIndex[0];
    else {
      activeChatId = uuid();
      chatsIndex = [activeChatId];
    }
  }
  ensureChat(activeChatId);
  if (!Array.isArray(chatsIndex)) chatsIndex = [activeChatId];
  if (!chatsIndex.includes(activeChatId)) chatsIndex.unshift(activeChatId);
  saveChats();

  initDrawerUser();
  renderPointsBar();
  renderTasks();
  renderMessages();
  renderChatsInHistory();
  cleanupEmptyChats();

  switchScreen("home");

  syncPull(true);
  setInterval(() => syncPull(false), 30000);

  console.log("[LSD] loaded. activeChatId =", activeChatId);
});
