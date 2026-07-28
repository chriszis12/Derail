// ============================================================================
// DERAIL β€” client.js
// Talks to the WebSocket server, keeps a copy of the room state, and renders
// whichever screen matches the current game phase. Also wires up i18n,
// sound effects, saved settings (localStorage), and the optional OAuth login.
// ============================================================================

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  let ws = null;
  let myId = null;
  let myCode = null;
  let latestState = null;
  let prevState = null; // previous snapshot, used to detect transitions for sfx/animation
  let currentUser = null; // { provider, identityId, name, avatar } | null

  document.getElementById("rand-case").textContent = String(1000 + Math.floor(Math.random() * 8999));

  // ---------------------------------------------------------------------
  // Settings: language + sound + remembered guest name (all in localStorage)
  // ---------------------------------------------------------------------

  function initSettings() {
    const savedLang = localStorage.getItem("derail:lang") || (navigator.language || "en").slice(0, 2);
    i18nSetLang(["en", "el", "es"].includes(savedLang) ? savedLang : "en");
    $("#lang-select").value = i18nGetLang();

    const savedName = localStorage.getItem("derail:name");
    if (savedName) $("#name-input").value = savedName;

    updateSoundButton();
    applyI18n();
  }

  $("#lang-select").addEventListener("change", (e) => {
    i18nSetLang(e.target.value);
    applyI18n();
    if (latestState) render(latestState);
  });

  $("#btn-sound").addEventListener("click", () => {
    Sound.setMuted(!Sound.isMuted());
    updateSoundButton();
    Sound.click();
  });

  function updateSoundButton() {
    const btn = $("#btn-sound");
    btn.textContent = Sound.isMuted() ? "π”‡" : "π”";
    btn.title = Sound.isMuted() ? t("sound_off") : t("sound_on");
  }

  $("#name-input").addEventListener("change", (e) => {
    localStorage.setItem("derail:name", e.target.value.trim().slice(0, 18));
  });

  function applyI18n() {
    $all("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const val = t(key);
      if (Array.isArray(val)) return; // handled specially (e.g. rules list)
      el.textContent = val;
    });
    $all("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    const rulesList = $("#rules-list");
    rulesList.innerHTML = "";
    t("rules").forEach((line) => {
      const li = document.createElement("li");
      // allow the DERAIL keyword to render bold, same as the original copy
      li.innerHTML = escapeHtml(line).replace(/DERAIL/g, "<b>DERAIL</b>");
      rulesList.appendChild(li);
    });
    document.documentElement.lang = i18nGetLang();
  }

  // ---------------------------------------------------------------------
  // Auth: check session, render login buttons / logged-in state
  // ---------------------------------------------------------------------

  const PROVIDER_LABELS = { google: "login_google", discord: "login_discord", github: "login_github" };
  const PROVIDER_ICONS = { google: "G", discord: "D", github: "GH" };

  async function initAuth() {
    try {
      const [providersRes, meRes] = await Promise.all([
        fetch("/auth/providers").then((r) => r.json()),
        fetch("/auth/me").then((r) => r.json()),
      ]);
      currentUser = meRes.user || null;
      renderAuthSection(providersRes.providers || []);
    } catch {
      // auth endpoints unreachable (e.g. static preview) β€” just hide the section
      $("#auth-section").classList.add("hidden");
    }
  }

  function renderAuthSection(providers) {
    const section = $("#auth-section");
    if (providers.length === 0 && !currentUser) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");

    const loggedOut = $("#auth-logged-out");
    const loggedIn = $("#auth-logged-in");

    if (currentUser) {
      loggedOut.classList.add("hidden");
      loggedIn.classList.remove("hidden");
      $("#auth-name-display").textContent = currentUser.name || "Player";
      const avatarEl = $("#auth-avatar");
      if (currentUser.avatar) {
        avatarEl.src = currentUser.avatar;
        avatarEl.classList.remove("hidden");
      } else {
        avatarEl.classList.add("hidden");
      }
      $("#name-input").value = currentUser.name || "";
      $("#name-input").disabled = true;
    } else {
      loggedOut.classList.remove("hidden");
      loggedIn.classList.add("hidden");
      $("#name-input").disabled = false;
      const btnWrap = $("#auth-buttons");
      btnWrap.innerHTML = "";
      providers.forEach((p) => {
        const a = document.createElement("a");
        a.href = `/auth/${p}`;
        a.className = `oauth-btn oauth-${p}`;
        a.innerHTML = `<span class="oauth-icon">${PROVIDER_ICONS[p] || "?"}</span> <span data-i18n="${PROVIDER_LABELS[p]}"></span>`;
        btnWrap.appendChild(a);
      });
      applyI18n();
    }
  }

  $("#btn-logout").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.reload();
  });

  // ---------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      handleMessage(msg);
    });
    ws.addEventListener("close", () => {
      showToast(t("toasts.connection_lost") || "connection lost β€” refresh to rejoin", "error");
    });
    return new Promise((resolve) => {
      ws.addEventListener("open", () => resolve(), { once: true });
    });
  }

  function sendMsg(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  async function ensureConnected() {
    if (!ws || ws.readyState !== WebSocket.OPEN) await connect();
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "joined":
        myId = msg.playerId;
        myCode = msg.code;
        break;
      case "error":
        $("#home-error").textContent = toastText(msg.code) || msg.code;
        break;
      case "toast":
        showToast(toastText(msg.code, msg.params), msg.tone);
        break;
      case "goal":
        break;
      case "state":
        prevState = latestState;
        latestState = msg;
        render(msg);
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Screen switching (with a soft fade + whoosh sfx on real transitions)
  // ---------------------------------------------------------------------

  const SCREEN_FOR_STATE = {
    lobby: "screen-lobby",
    playing: "screen-game",
    callout: "screen-game",
    voting: "screen-voting",
    reveal: "screen-reveal",
  };

  let currentScreenId = null;

  function showScreen(id) {
    if (id === currentScreenId) return;
    const wasFirstPaint = currentScreenId === null;
    currentScreenId = id;
    $all(".screen").forEach((s) => s.classList.remove("active"));
    const el = document.getElementById(id);
    if (el) {
      el.classList.add("active");
      el.classList.remove("screen-enter");
      void el.offsetWidth; // restart animation
      el.classList.add("screen-enter");
    }
    if (!wasFirstPaint) Sound.whoosh();
  }

  // ---------------------------------------------------------------------
  // Home screen: create / join
  // ---------------------------------------------------------------------

  $("#btn-create").addEventListener("click", async () => {
    Sound.click();
    const name = $("#name-input").value.trim() || "Player";
    if (!currentUser) localStorage.setItem("derail:name", name);
    $("#home-error").textContent = "";
    await ensureConnected();
    sendMsg({ type: "create_room", name });
  });

  $("#btn-join").addEventListener("click", async () => {
    Sound.click();
    const name = $("#name-input").value.trim() || "Player";
    const code = $("#code-input").value.trim().toUpperCase();
    if (!currentUser) localStorage.setItem("derail:name", name);
    $("#home-error").textContent = "";
    if (code.length !== 4) {
      $("#home-error").textContent = t("home_error_code_len");
      return;
    }
    await ensureConnected();
    sendMsg({ type: "join_room", name, code });
  });

  $("#code-input").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get("join")) {
    $("#code-input").value = urlParams.get("join").toUpperCase();
  }
  if (urlParams.get("auth") === "ok") {
    history.replaceState(null, "", location.pathname);
  }

  $("#btn-copy-link").addEventListener("click", () => {
    Sound.click();
    const url = `${location.origin}${location.pathname}?join=${myCode}`;
    navigator.clipboard?.writeText(url).then(() => showToast(t("copy_invite"), "success"));
  });

  $("#btn-leave").addEventListener("click", () => {
    Sound.click();
    sendMsg({ type: "leave_room" });
    location.reload();
  });

  // ---------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------

  $("#btn-start").addEventListener("click", () => {
    Sound.click();
    sendMsg({ type: "start_game" });
  });

  // ---------------------------------------------------------------------
  // Game: sentence submission
  // ---------------------------------------------------------------------

  $("#sentence-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#sentence-input");
    const text = input.value.trim();
    if (!text) return;
    sendMsg({ type: "submit_sentence", text });
    Sound.submit();
    input.value = "";
  });

  // ---------------------------------------------------------------------
  // Callout flow
  // ---------------------------------------------------------------------

  // A local mirror of the goal pool text so the accuser can pick a guess.
  // (kept in sync with server.js GOAL_POOL β€” see README for how to extend both.)
  const GOAL_POOL_CLIENT = [
    { id: "arrest", text: "The protagonist must get arrested for tax evasion." },
    { id: "horse", text: "Someone must ride a horse indoors." },
    { id: "ghost", text: "It must be revealed that the protagonist has been a ghost the whole time." },
    { id: "space", text: "The building must physically launch into space." },
    { id: "wedding", text: "An unplanned wedding must happen before the scene ends." },
    { id: "clone", text: "A character must turn out to be a clone or robot double." },
    { id: "kfire", text: "A kitchen fire must break out." },
    { id: "singing", text: "The scene must break into spontaneous group singing." },
    { id: "raccoon", text: "A raccoon must be revealed as the real mastermind." },
    { id: "timeloop", text: "It must become clear that this exact scene has happened before." },
    { id: "lottery", text: "Someone must win the lottery mid-scene." },
    { id: "alien", text: "A character must be exposed as an alien in disguise." },
    { id: "shrek", text: "The story must become a legally-distinct version of a certain ogre movie." },
    { id: "flood", text: "The room must start flooding with water." },
    { id: "celebrity", text: "A world-famous celebrity must walk in and be recognized." },
    { id: "breakup", text: "Two characters must break up on the spot." },
    { id: "heist", text: "A heist must begin before the scene ends." },
    { id: "dance", text: "A full choreographed dance number must break out." },
    { id: "twins", text: "A secret identical twin must appear." },
    { id: "portal", text: "A portal to another dimension must open." },
    { id: "normal", text: "Keep things completely normal β€” no twists, no chaos. Just a mundane, uneventful scene." },
  ];

  let lastCalloutResolvedKey = null;

  function renderCalloutOverlay(state) {
    const overlay = $("#overlay-callout");
    const c = state.callout;
    if (!c) {
      overlay.classList.add("hidden");
      $("#stamp-slam").classList.remove("show");
      lastCalloutResolvedKey = null;
      return;
    }
    overlay.classList.remove("hidden");

    $("#callout-desc").textContent =
      `${c.callerName} ${t("thinks_spotted")} ${c.targetName}${t("apostrophe_agenda")}`;
    const picker = $("#callout-picker");
    const waiting = $("#callout-waiting");
    const result = $("#callout-result");
    const stamp = $("#stamp-slam");

    if (c.resolved) {
      picker.innerHTML = "";
      picker.classList.add("hidden");
      waiting.classList.add("hidden");
      result.classList.remove("hidden");
      result.classList.toggle("correct", c.resolved.correct);
      result.classList.toggle("wrong", !c.resolved.correct);
      result.textContent = `${c.resolved.correct ? t("busted_result") : t("wrong_result")} "${c.resolved.actualText}"`;

      stamp.innerHTML = `<div class="stamp-text ${c.resolved.correct ? "busted" : "wrong"}">${
        c.resolved.correct ? t("stamp_busted") : t("stamp_wrong")
      }</div>`;

      const resolvedKey = `${c.callerId}:${c.targetId}:${c.resolved.correct}`;
      if (lastCalloutResolvedKey !== resolvedKey) {
        lastCalloutResolvedKey = resolvedKey;
        requestAnimationFrame(() => stamp.classList.add("show"));
        if (c.resolved.correct) Sound.stampBusted();
        else Sound.stampWrong();
      }
    } else {
      result.classList.add("hidden");
      stamp.classList.remove("show");
      if (c.callerId === myId) {
        picker.classList.remove("hidden");
        waiting.classList.add("hidden");
        picker.innerHTML = "";
        GOAL_POOL_CLIENT.forEach((g) => {
          const btn = document.createElement("button");
          btn.className = "goal-option";
          btn.textContent = g.text;
          btn.addEventListener("click", () => {
            Sound.click();
            sendMsg({ type: "resolve_callout", goalId: g.id });
          });
          picker.appendChild(btn);
        });
      } else {
        picker.classList.add("hidden");
        waiting.classList.remove("hidden");
        waiting.textContent = c.targetId === myId ? t("made_you") : t("waiting_accusation");
      }
    }

    tickTimer($("#callout-timer-fill"), c.endsAt, CALLOUT_DUR());
  }

  function CALLOUT_DUR() {
    return 20; // seconds β€” mirrors server CALLOUT_SECONDS
  }

  // ---------------------------------------------------------------------
  // Rendering: lobby
  // ---------------------------------------------------------------------

  function renderLobby(state) {
    $("#lobby-code").textContent = state.code;
    const list = $("#lobby-players");
    list.innerHTML = "";
    state.players.forEach((p, i) => {
      const li = document.createElement("li");
      li.style.animationDelay = `${i * 0.05}s`;
      li.classList.add("pop-in");
      li.innerHTML = `<span class="name">${escapeHtml(p.name)}${p.isHost ? `<span class="tag-host">${t("host_tag")}</span>` : ""}</span>` +
        (p.connected ? "" : `<span class="tag-off">${t("offline_tag")}</span>`);
      list.appendChild(li);
    });

    const me = state.players.find((p) => p.id === myId);
    const iAmHost = me?.isHost;
    $("#host-controls").classList.toggle("hidden", !iAmHost);
    $("#waiting-note").classList.toggle("hidden", !!iAmHost);
    $("#btn-start").disabled = state.players.filter((p) => p.connected).length < 2;
  }

  // ---------------------------------------------------------------------
  // Rendering: game (story + rail + turn/timer)
  // ---------------------------------------------------------------------

  function renderGame(state) {
    $("#game-code").textContent = state.code;
    $("#round-num").textContent = Math.min(state.round + 1, state.maxRounds);
    $("#round-max").textContent = state.maxRounds;
    $("#scenario-strip").textContent = state.scenario || "";

    $("#banned-strip").innerHTML =
      `<b>${t("redacted_words")}</b> ` + state.bannedWords.map((w) => `<span class="word">${escapeHtml(w)}</span>`).join(" ");

    // story feed β€” only animate lines that are new since the last render
    const feed = $("#story-feed");
    const prevLen = prevState?.story?.length ?? -1;
    feed.innerHTML = "";
    const open = document.createElement("div");
    open.className = "line opening";
    open.textContent = state.scenario || "";
    feed.appendChild(open);
    if (state.story.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = t("file_empty");
      feed.appendChild(empty);
    }
    state.story.forEach((s, i) => {
      const line = document.createElement("div");
      line.className = "line" + (i >= prevLen ? " line-enter" : "");
      line.innerHTML = `<span class="who">${escapeHtml(s.name)}</span>${escapeHtml(s.text)}`;
      feed.appendChild(line);
    });
    feed.scrollTop = feed.scrollHeight;

    // goal card
    $("#goal-text").textContent = state.myGoal || t("goal_loading");

    // suspect rail
    const rail = $("#player-rail");
    rail.innerHTML = "";
    state.players.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "suspect" + (p.id === state.currentTurnId ? " is-turn" : "") + (p.busted ? " is-busted" : "");
      li.style.animationDelay = `${i * 0.04}s`;
      const canCallOut =
        state.state === "playing" && p.id !== myId && p.connected && !p.busted &&
        !(latestState.players.find((x) => x.id === myId)?.busted);
      li.innerHTML = `
        <div class="who">
          <span class="n">${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>
          <span class="s">${p.score} ${t("pts")}${p.busted ? " Β· " + t("busted_tag") : ""}</span>
        </div>
        ${p.id !== myId ? `<button class="derail-btn" ${canCallOut ? "" : "disabled"}>${t("derail_btn")}</button>` : ""}
      `;
      if (p.id !== myId) {
        const btn = li.querySelector(".derail-btn");
        btn.addEventListener("click", () => {
          if (!canCallOut) return;
          Sound.derailSiren();
          sendMsg({ type: "start_callout", targetId: p.id });
        });
      }
      rail.appendChild(li);
    });

    // turn indicator + input enabling
    const turnEl = $("#turn-indicator");
    const input = $("#sentence-input");
    const submit = $("#sentence-submit");
    const isMyTurn = state.state === "playing" && state.currentTurnId === myId;
    const wasMyTurn = prevState?.state === "playing" && prevState?.currentTurnId === myId;

    if (state.state === "callout") {
      turnEl.textContent = t("paused_derail");
      input.disabled = true;
      submit.disabled = true;
    } else if (isMyTurn) {
      turnEl.innerHTML = `<span class="me">${t("your_turn")}</span> ${t("your_turn_rest")}`;
      input.disabled = false;
      submit.disabled = false;
      if (!wasMyTurn) Sound.yourTurn();
    } else {
      const currentP = state.players.find((p) => p.id === state.currentTurnId);
      turnEl.innerHTML = `${t("waiting_on")} <b>${escapeHtml(currentP?.name || "β€¦")}</b>&hellip;`;
      input.disabled = true;
      submit.disabled = true;
    }

    tickTimer($("#timer-fill"), state.turnEndsAt, 15, isMyTurn);

    renderCalloutOverlay(state);
  }

  // ---------------------------------------------------------------------
  // Rendering: voting
  // ---------------------------------------------------------------------

  function renderVoting(state) {
    $("#voting-code").textContent = state.code;
    const list = $("#voting-list");
    list.innerHTML = "";
    const v = state.voting;
    if (!v) return;

    v.subjects.forEach((subj, i) => {
      const li = document.createElement("li");
      li.className = "voting-item pop-in";
      li.style.animationDelay = `${i * 0.06}s`;
      const already = v.myVotes.includes(subj.id);
      const isSelf = subj.id === myId;
      li.innerHTML = `
        <div class="who">${escapeHtml(subj.name)}</div>
        <div class="g">${escapeHtml(subj.goal?.text || "")}</div>
        <div class="vote-row">
          <button class="vote-btn yes" ${already || isSelf ? "disabled" : ""}>${t("did_it")}</button>
          <button class="vote-btn no" ${already || isSelf ? "disabled" : ""}>${t("nah")}</button>
          ${isSelf ? `<span class="vote-tally">${t("cant_vote_self")}</span>` : already ? `<span class="vote-tally">${t("vote_locked")}</span>` : ""}
        </div>
      `;
      if (!already && !isSelf) {
        li.querySelector(".yes").addEventListener("click", () => {
          Sound.click();
          sendMsg({ type: "cast_vote", subjectId: subj.id, verdict: "yes" });
        });
        li.querySelector(".no").addEventListener("click", () => {
          Sound.click();
          sendMsg({ type: "cast_vote", subjectId: subj.id, verdict: "no" });
        });
      }
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------------
  // Rendering: reveal
  // ---------------------------------------------------------------------

  let revealSfxPlayed = false;

  function renderReveal(state) {
    $("#reveal-code").textContent = state.code;
    const board = $("#reveal-scoreboard");
    board.innerHTML = "";
    const ranked = state.players.slice().sort((a, b) => b.score - a.score);
    const results = state.reveal?.results || {};
    const goals = state.reveal?.goals || {};

    ranked.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "pop-in";
      li.style.animationDelay = `${i * 0.08}s`;
      const g = goals[p.id];
      const r = results[p.id];
      let stamp = "";
      if (p.busted) stamp = `<span class="stamp-mini busted">${t("stamp_busted")}</span>`;
      else if (r) stamp = r.success
        ? `<span class="stamp-mini success">${t("pulled_it_off")}</span>`
        : `<span class="stamp-mini fail">${t("didnt_land")}</span>`;
      li.innerHTML = `
        <span class="n">${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>
        ${stamp}
        <span class="pts">${p.score} ${t("pts")}</span>
        ${g ? `<div class="goal-mini">${escapeHtml(g.text)}</div>` : ""}
      `;
      board.appendChild(li);
    });

    if (!revealSfxPlayed) {
      revealSfxPlayed = true;
      const me = state.players.find((p) => p.id === myId);
      const myResult = results[myId];
      if (me?.busted || (myResult && !myResult.success)) Sound.fail();
      else if (myResult && myResult.success) Sound.success();
    }

    const story = $("#reveal-story");
    story.innerHTML = "";
    const open = document.createElement("div");
    open.className = "line opening";
    open.textContent = state.scenario || "";
    story.appendChild(open);
    state.story.forEach((s) => {
      const line = document.createElement("div");
      line.className = "line";
      line.innerHTML = `<span class="who">${escapeHtml(s.name)}</span>${escapeHtml(s.text)}`;
      story.appendChild(line);
    });

    const me = state.players.find((p) => p.id === myId);
    $("#reveal-host-controls").classList.toggle("hidden", !me?.isHost);
  }

  $("#btn-play-again").addEventListener("click", () => {
    Sound.click();
    revealSfxPlayed = false;
    sendMsg({ type: "play_again" });
  });

  // ---------------------------------------------------------------------
  // Master render dispatch
  // ---------------------------------------------------------------------

  function render(state) {
    const screenId = SCREEN_FOR_STATE[state.state] || "screen-lobby";
    showScreen(screenId);

    if (state.state === "lobby") renderLobby(state);
    else if (state.state === "playing" || state.state === "callout") renderGame(state);
    else if (state.state === "voting") renderVoting(state);
    else if (state.state === "reveal") renderReveal(state);
  }

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const timerFrames = new WeakMap();
  const timerTicked = new WeakMap();

  function tickTimer(el, endsAt, durationSeconds, playTickSfx = false) {
    if (!el || !endsAt) {
      if (el) el.style.width = "100%";
      return;
    }
    cancelAnimationFrame(timerFrames.get(el));
    timerTicked.set(el, timerTicked.get(el) || new Set());
    function step() {
      const remaining = Math.max(0, endsAt - Date.now());
      const pct = Math.max(0, Math.min(100, (remaining / (durationSeconds * 1000)) * 100));
      el.style.width = pct + "%";
      el.classList.toggle("timer-critical", remaining < 4000 && remaining > 0);
      if (playTickSfx) {
        const secLeft = Math.ceil(remaining / 1000);
        const ticked = timerTicked.get(el);
        if (secLeft <= 3 && secLeft > 0 && !ticked.has(secLeft)) {
          ticked.add(secLeft);
          Sound.tick();
        }
      }
      if (remaining > 0) {
        timerFrames.set(el, requestAnimationFrame(step));
      } else {
        timerTicked.set(el, new Set());
      }
    }
    step();
  }

  function showToast(message, tone = "info") {
    const stack = $("#toast-stack");
    const el = document.createElement("div");
    el.className = `toast ${tone} toast-in`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  initSettings();
  initAuth();
})();
