// ============================================================================
// DERAIL — client.js
// Talks to the WebSocket server, keeps a copy of the room state, and renders
// whichever screen matches the current game phase.
// ============================================================================

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  let ws = null;
  let myId = null;
  let myCode = null;
  let latestState = null;

  document.getElementById("rand-case").textContent = String(1000 + Math.floor(Math.random() * 8999));

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
      showToast("connection lost — refresh to rejoin", "error");
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
        $("#home-error").textContent = msg.message;
        break;
      case "toast":
        showToast(msg.message, msg.tone);
        break;
      case "goal":
        // handled via state.myGoal, but flash a toast the first time
        break;
      case "state":
        latestState = msg;
        render(msg);
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Screen switching
  // ---------------------------------------------------------------------

  const SCREEN_FOR_STATE = {
    lobby: "screen-lobby",
    playing: "screen-game",
    callout: "screen-game",
    voting: "screen-voting",
    reveal: "screen-reveal",
  };

  function showScreen(id) {
    $all(".screen").forEach((s) => s.classList.remove("active"));
    const el = document.getElementById(id);
    if (el) el.classList.add("active");
  }

  // ---------------------------------------------------------------------
  // Home screen: create / join
  // ---------------------------------------------------------------------

  $("#btn-create").addEventListener("click", async () => {
    const name = $("#name-input").value.trim() || "Player";
    $("#home-error").textContent = "";
    await ensureConnected();
    sendMsg({ type: "create_room", name });
  });

  $("#btn-join").addEventListener("click", async () => {
    const name = $("#name-input").value.trim() || "Player";
    const code = $("#code-input").value.trim().toUpperCase();
    $("#home-error").textContent = "";
    if (code.length !== 4) {
      $("#home-error").textContent = "room codes are 4 characters";
      return;
    }
    await ensureConnected();
    sendMsg({ type: "join_room", name, code });
  });

  $("#code-input").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  // check URL for ?join=CODE
  const params = new URLSearchParams(location.search);
  if (params.get("join")) {
    $("#code-input").value = params.get("join").toUpperCase();
  }

  $("#btn-copy-link").addEventListener("click", () => {
    const url = `${location.origin}${location.pathname}?join=${myCode}`;
    navigator.clipboard?.writeText(url).then(() => showToast("invite link copied", "success"));
  });

  $("#btn-leave").addEventListener("click", () => {
    sendMsg({ type: "leave_room" });
    location.reload();
  });

  // ---------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------

  $("#btn-start").addEventListener("click", () => sendMsg({ type: "start_game" }));

  // ---------------------------------------------------------------------
  // Game: sentence submission
  // ---------------------------------------------------------------------

  $("#sentence-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#sentence-input");
    const text = input.value.trim();
    if (!text) return;
    sendMsg({ type: "submit_sentence", text });
    input.value = "";
  });

  // ---------------------------------------------------------------------
  // Callout flow
  // ---------------------------------------------------------------------

  // A local mirror of the goal pool text so the accuser can pick a guess.
  // (kept in sync with server.js GOAL_POOL — see README for how to extend both.)
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
    { id: "normal", text: "Keep things completely normal — no twists, no chaos. Just a mundane, uneventful scene." },
  ];

  function renderCalloutOverlay(state) {
    const overlay = $("#overlay-callout");
    const c = state.callout;
    if (!c) {
      overlay.classList.add("hidden");
      $("#stamp-slam").classList.remove("show");
      return;
    }
    overlay.classList.remove("hidden");

    $("#callout-desc").textContent = `${c.callerName} thinks they've spotted ${c.targetName}'s agenda.`;
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
      result.textContent = c.resolved.correct
        ? `busted! their goal was: "${c.resolved.actualText}"`
        : `wrong! actual goal was: "${c.resolved.actualText}"`;

      stamp.innerHTML = `<div class="stamp-text ${c.resolved.correct ? "busted" : "wrong"}">${
        c.resolved.correct ? "BUSTED" : "NOT QUITE"
      }</div>`;
      requestAnimationFrame(() => stamp.classList.add("show"));
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
          btn.addEventListener("click", () => sendMsg({ type: "resolve_callout", goalId: g.id }));
          picker.appendChild(btn);
        });
      } else {
        picker.classList.add("hidden");
        waiting.classList.remove("hidden");
        waiting.textContent =
          c.targetId === myId
            ? "someone thinks they've made you. sit tight."
            : "waiting for the accusation…";
      }
    }

    tickTimer($("#callout-timer-fill"), c.endsAt, CALLOUT_DUR());
  }

  function CALLOUT_DUR() {
    return 20; // seconds — mirrors server CALLOUT_SECONDS
  }

  // ---------------------------------------------------------------------
  // Rendering: lobby
  // ---------------------------------------------------------------------

  function renderLobby(state) {
    $("#lobby-code").textContent = state.code;
    const list = $("#lobby-players");
    list.innerHTML = "";
    state.players.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="name">${escapeHtml(p.name)}${p.isHost ? '<span class="tag-host">HOST</span>' : ""}</span>` +
        (p.connected ? "" : '<span class="tag-off">offline</span>');
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
      `<b>redacted words:</b> ` + state.bannedWords.map((w) => `<span class="word">${escapeHtml(w)}</span>`).join(" ");

    // story feed
    const feed = $("#story-feed");
    feed.innerHTML = "";
    const open = document.createElement("div");
    open.className = "line opening";
    open.textContent = state.scenario || "";
    feed.appendChild(open);
    if (state.story.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "the file is still empty — someone should write the next line.";
      feed.appendChild(empty);
    }
    state.story.forEach((s) => {
      const line = document.createElement("div");
      line.className = "line";
      line.innerHTML = `<span class="who">${escapeHtml(s.name)}</span>${escapeHtml(s.text)}`;
      feed.appendChild(line);
    });
    feed.scrollTop = feed.scrollHeight;

    // goal card
    $("#goal-text").textContent = state.myGoal || "…";

    // suspect rail
    const rail = $("#player-rail");
    rail.innerHTML = "";
    state.players.forEach((p) => {
      const li = document.createElement("li");
      li.className = "suspect" + (p.id === state.currentTurnId ? " is-turn" : "") + (p.busted ? " is-busted" : "");
      const canCallOut =
        state.state === "playing" && p.id !== myId && p.connected && !p.busted &&
        !(latestState.players.find((x) => x.id === myId)?.busted);
      li.innerHTML = `
        <div class="who">
          <span class="n">${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>
          <span class="s">${p.score} pts${p.busted ? " · busted" : ""}</span>
        </div>
        ${p.id !== myId ? `<button class="derail-btn" ${canCallOut ? "" : "disabled"}>DERAIL</button>` : ""}
      `;
      if (p.id !== myId) {
        const btn = li.querySelector(".derail-btn");
        btn.addEventListener("click", () => {
          if (!canCallOut) return;
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
    if (state.state === "callout") {
      turnEl.innerHTML = `paused — a derail is being sorted out.`;
      input.disabled = true;
      submit.disabled = true;
    } else if (isMyTurn) {
      turnEl.innerHTML = `<span class="me">it's your turn</span> — add one sentence before the clock runs out.`;
      input.disabled = false;
      submit.disabled = false;
    } else {
      const currentP = state.players.find((p) => p.id === state.currentTurnId);
      turnEl.innerHTML = `waiting on <b>${escapeHtml(currentP?.name || "someone")}</b>&hellip;`;
      input.disabled = true;
      submit.disabled = true;
    }

    tickTimer($("#timer-fill"), state.turnEndsAt, 15);

    renderCalloutOverlay(state);
  }

  // ---------------------------------------------------------------------
  // Rendering: voting
  // ---------------------------------------------------------------------

  const votedTracker = new Set();

  function renderVoting(state) {
    $("#voting-code").textContent = state.code;
    const list = $("#voting-list");
    list.innerHTML = "";
    const v = state.voting;
    if (!v) return;

    v.subjects.forEach((subj) => {
      const li = document.createElement("li");
      li.className = "voting-item";
      const already = v.myVotes.includes(subj.id);
      const isSelf = subj.id === myId;
      li.innerHTML = `
        <div class="who">${escapeHtml(subj.name)}</div>
        <div class="g">${escapeHtml(subj.goal?.text || "")}</div>
        <div class="vote-row">
          <button class="vote-btn yes" ${already || isSelf ? "disabled" : ""}>did it</button>
          <button class="vote-btn no" ${already || isSelf ? "disabled" : ""}>nah</button>
          ${isSelf ? '<span class="vote-tally">(can\'t vote for yourself)</span>' : already ? '<span class="vote-tally">vote locked in</span>' : ""}
        </div>
      `;
      if (!already && !isSelf) {
        li.querySelector(".yes").addEventListener("click", () =>
          sendMsg({ type: "cast_vote", subjectId: subj.id, verdict: "yes" })
        );
        li.querySelector(".no").addEventListener("click", () =>
          sendMsg({ type: "cast_vote", subjectId: subj.id, verdict: "no" })
        );
      }
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------------
  // Rendering: reveal
  // ---------------------------------------------------------------------

  function renderReveal(state) {
    $("#reveal-code").textContent = state.code;
    const board = $("#reveal-scoreboard");
    board.innerHTML = "";
    const ranked = state.players.slice().sort((a, b) => b.score - a.score);
    const results = state.reveal?.results || {};
    const goals = state.reveal?.goals || {};

    ranked.forEach((p) => {
      const li = document.createElement("li");
      const g = goals[p.id];
      const r = results[p.id];
      let stamp = "";
      if (p.busted) stamp = '<span class="stamp-mini busted">BUSTED</span>';
      else if (r) stamp = r.success ? '<span class="stamp-mini success">PULLED IT OFF</span>' : '<span class="stamp-mini fail">DIDN\'T LAND</span>';
      li.innerHTML = `
        <span class="n">${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>
        ${stamp}
        <span class="pts">${p.score} pts</span>
        ${g ? `<div class="goal-mini">${escapeHtml(g.text)}</div>` : ""}
      `;
      board.appendChild(li);
    });

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

  $("#btn-play-again").addEventListener("click", () => sendMsg({ type: "play_again" }));

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

  function tickTimer(el, endsAt, durationSeconds) {
    if (!el || !endsAt) {
      if (el) el.style.width = "100%";
      return;
    }
    cancelAnimationFrame(timerFrames.get(el));
    function step() {
      const remaining = Math.max(0, endsAt - Date.now());
      const pct = Math.max(0, Math.min(100, (remaining / (durationSeconds * 1000)) * 100));
      el.style.width = pct + "%";
      if (remaining > 0) {
        timerFrames.set(el, requestAnimationFrame(step));
      }
    }
    step();
  }

  function showToast(message, tone = "info") {
    const stack = $("#toast-stack");
    const el = document.createElement("div");
    el.className = `toast ${tone}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
})();
