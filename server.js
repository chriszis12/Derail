// ============================================================================
// DERAIL — server.js
// Express serves the static client. A single WebSocket server runs the whole
// game engine: rooms, turns, timers, callouts, voting, and scoring all live
// here, in memory. No database — rooms disappear when the last person leaves.
// ============================================================================

const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { WebSocketServer } = require("ws");
const { setupPassport, configuredProviders } = require("./auth");

const PORT = process.env.PORT || 8080;
const IS_PROD = process.env.NODE_ENV === "production";

// A signed, httpOnly session cookie is how we recognize "the same browser"
// (guests) or "the same OAuth account" (logged-in players) across requests
// and across the WebSocket handshake. The cookie itself never contains
// player data — just an opaque, server-signed session id.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn(
    "[derail] SESSION_SECRET not set — using a random one for this process only. " +
      "Logins will be forgotten on every restart. Set SESSION_SECRET in production."
  );
}

const sessionParser = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  },
});

const passport = setupPassport();

const app = express();
if (IS_PROD) app.set("trust proxy", 1); // needed so `secure` cookies work behind Render/Railway/Fly proxies
app.use(sessionParser);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, "public")));

// ----------------------------------------------------------------------------
// Auth routes — each one only exists if its env vars are configured.
// ----------------------------------------------------------------------------

app.get("/auth/providers", (req, res) => res.json({ providers: configuredProviders() }));

app.get("/auth/me", (req, res) => {
  res.json({ user: req.user || null });
});

app.post("/auth/logout", (req, res) => {
  req.logout(() => res.json({ ok: true }));
});

if (configuredProviders().includes("google")) {
  app.get("/auth/google", passport.authenticate("google", { scope: ["profile"] }));
  app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/?auth=failed" }),
    (req, res) => res.redirect("/?auth=ok")
  );
}
if (configuredProviders().includes("github")) {
  app.get("/auth/github", passport.authenticate("github", { scope: ["read:user"] }));
  app.get(
    "/auth/github/callback",
    passport.authenticate("github", { failureRedirect: "/?auth=failed" }),
    (req, res) => res.redirect("/?auth=ok")
  );
}
if (configuredProviders().includes("discord")) {
  app.get("/auth/discord", passport.authenticate("discord"));
  app.get(
    "/auth/discord/callback",
    passport.authenticate("discord", { failureRedirect: "/?auth=failed" }),
    (req, res) => res.redirect("/?auth=ok")
  );
}

const server = http.createServer(app);
// `noServer` + manual upgrade handling lets us run the same sessionParser
// (and therefore know who's logged in) before a WebSocket connection opens.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  sessionParser(req, {}, () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
});

// ----------------------------------------------------------------------------
// Content pools
// ----------------------------------------------------------------------------

const SCENARIOS = [
  "Dave walks into a diner at 2:00 AM and sits at the counter.",
  "The city council meeting starts thirty seconds late, as always.",
  "Margaret finds a package on her porch that she didn't order.",
  "The intern is the last one left in the office at 6 PM.",
  "A man in a rumpled suit boards the 11:42 train to nowhere in particular.",
  "The wedding photographer arrives an hour before the ceremony.",
  "Two coworkers are stuck in an elevator between the 3rd and 4th floor.",
  "The new tenant is unpacking boxes in apartment 4B.",
  "A substitute teacher takes attendance for the first time.",
  "The night security guard clocks in for another quiet shift at the museum.",
];

// Regular goals. `trojan: true` marks the one "just be normal" goal.
const GOAL_POOL = [
  { id: "arrest", text: "The protagonist must get arrested for tax evasion.", trojan: false },
  { id: "horse", text: "Someone must ride a horse indoors.", trojan: false },
  { id: "ghost", text: "It must be revealed that the protagonist has been a ghost the whole time.", trojan: false },
  { id: "space", text: "The building must physically launch into space.", trojan: false },
  { id: "wedding", text: "An unplanned wedding must happen before the scene ends.", trojan: false },
  { id: "clone", text: "A character must turn out to be a clone or robot double.", trojan: false },
  { id: "kfire", text: "A kitchen fire must break out.", trojan: false },
  { id: "singing", text: "The scene must break into spontaneous group singing.", trojan: false },
  { id: "raccoon", text: "A raccoon must be revealed as the real mastermind.", trojan: false },
  { id: "timeloop", text: "It must become clear that this exact scene has happened before.", trojan: false },
  { id: "lottery", text: "Someone must win the lottery mid-scene.", trojan: false },
  { id: "alien", text: "A character must be exposed as an alien in disguise.", trojan: false },
  { id: "shrek", text: "The story must become a legally-distinct version of a certain ogre movie.", trojan: false },
  { id: "flood", text: "The room must start flooding with water.", trojan: false },
  { id: "celebrity", text: "A world-famous celebrity must walk in and be recognized.", trojan: false },
  { id: "breakup", text: "Two characters must break up on the spot.", trojan: false },
  { id: "heist", text: "A heist must begin before the scene ends.", trojan: false },
  { id: "dance", text: "A full choreographed dance number must break out.", trojan: false },
  { id: "twins", text: "A secret identical twin must appear.", trojan: false },
  { id: "portal", text: "A portal to another dimension must open.", trojan: false },
  { id: "normal", text: "Keep things completely normal — no twists, no chaos. Just a mundane, uneventful scene.", trojan: true },
];

const BANNED_WORD_POOL = [
  "suddenly", "alien", "gun", "ghost", "explode", "magic", "secretly",
  "horse", "space", "wedding", "fire", "twin", "portal", "clone",
  "dance", "raccoon", "flood", "shrek", "lottery", "heist",
];

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

const TURN_SECONDS = 15;
const MAX_ROUNDS = 10;
const GAME_TIME_LIMIT_MS = 3 * 60 * 1000;
const VOTE_SECONDS = 15;
const CALLOUT_SECONDS = 20;

// ----------------------------------------------------------------------------
// Room state
// ----------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function makeRoom(code) {
  return {
    code,
    players: new Map(), // id -> player
    hostId: null,
    state: "lobby", // lobby | playing | callout | voting | reveal
    scenario: null,
    story: [], // { text, playerId, name }
    turnOrder: [],
    currentTurnIndex: 0,
    round: 0,
    bannedWords: [],
    startedAt: null,
    turnTimer: null,
    turnEndsAt: null,
    skipNextTurn: new Set(), // player ids who lose their next turn
    callout: null, // { callerId, targetId, endsAt, timer }
    voting: null, // { subjects: [playerId...], ballots: Map(subjectId -> {yes,no}), voters: Map(voterId -> Set(subjectId voted)), endsAt, timer }
  };
}

function getRoom(code) {
  return rooms.get(code);
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar || null,
    account: !!p.account,
    connected: p.connected,
    score: p.score,
    busted: p.busted,
    isHost: p.isHost,
  };
}

function roomSnapshot(room, forPlayerId) {
  const me = room.players.get(forPlayerId);
  return {
    type: "state",
    code: room.code,
    state: room.state,
    scenario: room.scenario,
    story: room.story,
    players: Array.from(room.players.values()).map(publicPlayer),
    turnOrder: room.turnOrder,
    currentTurnId: room.turnOrder[room.currentTurnIndex] || null,
    round: room.round,
    maxRounds: MAX_ROUNDS,
    bannedWords: room.bannedWords,
    turnEndsAt: room.turnEndsAt,
    myGoal: me && me.goal ? me.goal.text : null,
    myBusted: me ? me.busted : false,
    callout: room.callout
      ? {
          callerId: room.callout.callerId,
          callerName: room.players.get(room.callout.callerId)?.name,
          targetId: room.callout.targetId,
          targetName: room.players.get(room.callout.targetId)?.name,
          endsAt: room.callout.endsAt,
          resolved: room.callout.resolved || null, // { correct, guessText, actualText }
        }
      : null,
    voting: room.voting
      ? {
          subjects: room.voting.subjects.map((id) => ({
            id,
            name: room.players.get(id)?.name,
            goal: room.reveal ? room.reveal.goals[id] : null,
          })),
          endsAt: room.voting.endsAt,
          myVotes: Array.from(room.voting.voters.get(forPlayerId) || []),
        }
      : null,
    reveal: room.reveal || null,
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(roomSnapshot(room, p.id)));
    }
  }
}

function send(p, payload) {
  if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(payload));
}

function toast(room, playerId, code, tone = "info", params = null) {
  const p = room.players.get(playerId);
  if (p) send(p, { type: "toast", code, params, tone });
}

// ----------------------------------------------------------------------------
// Game flow
// ----------------------------------------------------------------------------

function connectedPlayers(room) {
  return Array.from(room.players.values()).filter((p) => p.connected);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startGame(room) {
  const players = connectedPlayers(room);
  if (players.length < 2) return false;

  room.state = "playing";
  room.story = [];
  room.round = 0;
  room.startedAt = Date.now();
  room.callout = null;
  room.voting = null;
  room.reveal = null;

  room.scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];

  // Assign goals: guarantee one trojan goal max, rest unique non-trojan.
  const trojan = GOAL_POOL.find((g) => g.trojan);
  const normalGoals = shuffle(GOAL_POOL.filter((g) => !g.trojan));
  const includeTrojan = players.length >= 3; // only worth it with enough players
  const chosen = includeTrojan ? [trojan, ...normalGoals] : normalGoals;

  const shuffledPlayers = shuffle(players);
  shuffledPlayers.forEach((p, i) => {
    p.goal = chosen[i % chosen.length];
    p.busted = false;
    p.calledOutCorrectlyBy = null;
  });

  room.bannedWords = shuffle(BANNED_WORD_POOL).slice(0, 2);
  room.turnOrder = shuffle(players.map((p) => p.id));
  room.currentTurnIndex = 0;
  room.skipNextTurn = new Set();

  for (const p of players) {
    send(p, { type: "goal", goal: p.goal.text, trojan: !!p.goal.trojan });
  }

  advanceToNextWriter(room, true);
  broadcast(room);
  return true;
}

function activeCandidates(room) {
  return room.turnOrder.filter((id) => {
    const p = room.players.get(id);
    return p && p.connected && !p.busted;
  });
}

function advanceToNextWriter(room, isFirst = false) {
  clearTurnTimer(room);

  if (room.round >= MAX_ROUNDS || Date.now() - room.startedAt >= GAME_TIME_LIMIT_MS) {
    return startReveal(room);
  }
  if (activeCandidates(room).length === 0) {
    return startReveal(room);
  }

  let attempts = 0;
  let idx = isFirst ? -1 : room.currentTurnIndex;
  
  while (attempts < room.turnOrder.length) {
    idx = (idx + 1) % room.turnOrder.length;
    attempts += 1;
    const candidateId = room.turnOrder[idx];
    const cp = room.players.get(candidateId);
    
    if (cp && cp.connected && !cp.busted) {
      if (room.skipNextTurn.has(candidateId)) {
        room.skipNextTurn.delete(candidateId);
        toast(room, candidateId, "lost_turn_wrong_callout", "warn");
        continue; 
      }
      
      // Only increment the round when we successfully wrap back around the order
      if (!isFirst && idx <= room.currentTurnIndex) {
        room.round += 1;
        if (room.round >= MAX_ROUNDS) {
          return startReveal(room);
        }
      }
      
      room.currentTurnIndex = idx;
      startTurnTimer(room);
      return;
    }
  }
  // nobody eligible
  startReveal(room);
}

function startTurnTimer(room) {
  room.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
  clearTurnTimer(room);
  room.turnTimer = setTimeout(() => {
    const currentId = room.turnOrder[room.currentTurnIndex];
    toast(room, currentId, "turn_skipped", "warn");
    advanceToNextWriter(room);
    broadcast(room);
  }, TURN_SECONDS * 1000);
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function containsBannedWord(text, bannedWords) {
  const lower = text.toLowerCase();
  return bannedWords.find((w) => new RegExp(`\\b${w}\\b`, "i").test(lower));
}

function submitSentence(room, playerId, text) {
  if (room.state !== "playing") return;
  const currentId = room.turnOrder[room.currentTurnIndex];
  if (currentId !== playerId) return;
  const player = room.players.get(playerId);
  if (!player || player.busted) return;

  const clean = String(text || "").trim().slice(0, 220);
  if (!clean) return;

  const hit = containsBannedWord(clean, room.bannedWords);
  if (hit) {
    toast(room, playerId, "banned_word", "error", { word: hit });
    return;
  }

  room.story.push({ text: clean, playerId, name: player.name });
  advanceToNextWriter(room);
  broadcast(room);
}

// ----------------------------------------------------------------------------
// Callouts
// ----------------------------------------------------------------------------

function startCallout(room, callerId, targetId) {
  if (room.state !== "playing") return;
  if (room.callout) return;
  const caller = room.players.get(callerId);
  const target = room.players.get(targetId);
  if (!caller || !target || caller.busted || target.busted || callerId === targetId) return;

  clearTurnTimer(room);
  room.state = "callout";
  room.callout = {
    callerId,
    targetId,
    endsAt: Date.now() + CALLOUT_SECONDS * 1000,
    timer: setTimeout(() => resolveCallout(room, null), CALLOUT_SECONDS * 1000),
    resolved: null,
  };
  broadcast(room);
}

function resolveCallout(room, guessedGoalId) {
  if (!room.callout) return;
  const { callerId, targetId, timer } = room.callout;
  if (timer) clearTimeout(timer);

  const caller = room.players.get(callerId);
  const target = room.players.get(targetId);

  let correct = false;
  if (caller && target && guessedGoalId) {
    correct = target.goal && target.goal.id === guessedGoalId;
  }

  if (correct) {
    target.busted = true;
    caller.score += 15;
    toast(room, callerId, "callout_correct_points", "success");
    toast(room, targetId, "busted_by", "error", { name: caller.name });
  } else if (guessedGoalId) {
    room.skipNextTurn.add(callerId);
    toast(room, callerId, "callout_wrong_lose_turn", "warn");
    if (target) toast(room, targetId, "accused_wrong", "info", { name: caller?.name || "?" });
  } else {
    toast(room, callerId, "callout_timeout", "warn");
  }

  room.callout.resolved = {
    correct,
    guessText: guessedGoalId ? GOAL_POOL.find((g) => g.id === guessedGoalId)?.text : null,
    actualText: target ? target.goal.text : null,
  };
  broadcast(room);

  setTimeout(() => {
    if (!room.callout) return;
    room.callout = null;
    room.state = "playing";
    // Resume: current writer might now be busted if they were target — re-derive.
    if (activeCandidates(room).length === 0) {
      startReveal(room);
    } else {
      const currentId = room.turnOrder[room.currentTurnIndex];
      const currentP = room.players.get(currentId);
      if (!currentP || !currentP.connected || currentP.busted) {
        advanceToNextWriter(room);
      } else {
        startTurnTimer(room);
      }
    }
    broadcast(room);
  }, 3200);
}

// ----------------------------------------------------------------------------
// Reveal & voting
// ----------------------------------------------------------------------------

function startReveal(room) {
  clearTurnTimer(room);
  room.state = "voting";
  const subjects = connectedPlayers(room)
    .filter((p) => !p.busted)
    .map((p) => p.id);

  const goals = {};
  for (const p of room.players.values()) {
    if (p.goal) goals[p.id] = { text: p.goal.text, trojan: !!p.goal.trojan, busted: p.busted };
  }
  room.reveal = { goals, finished: false };

  room.voting = {
    subjects,
    ballots: new Map(subjects.map((id) => [id, { yes: 0, no: 0 }])),
    voters: new Map(),
    endsAt: Date.now() + VOTE_SECONDS * 1000,
    timer: setTimeout(() => finishVoting(room), VOTE_SECONDS * 1000),
  };
  broadcast(room);
}

function castVote(room, voterId, subjectId, verdict) {
  if (room.state !== "voting" || !room.voting) return;
  if (!room.voting.subjects.includes(subjectId)) return;
  if (voterId === subjectId) return;

  const already = room.voting.voters.get(voterId) || new Set();
  if (already.has(subjectId)) return;
  already.add(subjectId);
  room.voting.voters.set(voterId, already);

  const ballot = room.voting.ballots.get(subjectId);
  if (verdict === "yes") ballot.yes += 1;
  else ballot.no += 1;

  broadcast(room);

  const totalVoters = connectedPlayers(room).length;
  const everyoneVotedOnEverything = Array.from(room.voting.voters.entries()).length >= 0 &&
    room.voting.subjects.every((subj) => {
      let count = 0;
      for (const [voter, set] of room.voting.voters.entries()) {
        if (set.has(subj)) count += 1;
      }
      const eligibleVoters = totalVoters - 1; // subject can't vote for self
      return count >= Math.max(eligibleVoters, 0);
    });

  if (everyoneVotedOnEverything) finishVoting(room);
}

function finishVoting(room) {
  if (!room.voting) return;
  if (room.voting.timer) clearTimeout(room.voting.timer);

  const results = {};
  for (const [subjId, ballot] of room.voting.ballots.entries()) {
    const success = ballot.yes >= ballot.no && (ballot.yes + ballot.no) > 0 ? true : ballot.yes > ballot.no;
    results[subjId] = { yes: ballot.yes, no: ballot.no, success };
    const p = room.players.get(subjId);
    if (p && success) p.score += 10;
  }

  room.reveal.results = results;
  room.reveal.finished = true;
  room.voting = null;
  room.state = "reveal";
  broadcast(room);
}

function playAgain(room) {
  room.callout = null;
  room.voting = null;
  room.reveal = null;
  for (const p of room.players.values()) {
    p.busted = false;
    p.goal = null;
  }
  room.state = "lobby";
  broadcast(room);
}

// ----------------------------------------------------------------------------
// WebSocket wiring
// ----------------------------------------------------------------------------

/**
 * Derive a stable identity for this connection:
 *  - Logged in via Google/GitHub/Discord -> identity is the OAuth account
 *    itself (`google:12345`), so the SAME account can never occupy two
 *    seats in the same room, even from two different browsers.
 *  - Guest -> a random id is minted once and stashed in the session, so a
 *    refresh or a second tab from the same browser is recognized as the
 *    same person rather than a new player.
 */
function identityFromRequest(req) {
  if (req.session?.passport?.user) {
    const u = req.session.passport.user;
    return { identityId: u.identityId, name: u.name, avatar: u.avatar, account: true };
  }
  if (!req.session.guestId) {
    req.session.guestId = "guest:" + crypto.randomBytes(9).toString("hex");
    req.session.save?.(() => {});
  }
  return { identityId: req.session.guestId, name: null, avatar: null, account: false };
}

wss.on("connection", (ws, req) => {
  const identity = identityFromRequest(req);
  const playerId = identity.identityId;
  let currentRoomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "create_room") {
      const code = roomCode();
      const room = makeRoom(code);
      rooms.set(code, room);
      joinRoom(room, msg.name);
      return;
    }

    if (msg.type === "join_room") {
      const room = getRoom(String(msg.code || "").toUpperCase());
      if (!room) {
        ws.send(JSON.stringify({ type: "error", code: "room_not_found" }));
        return;
      }
      
      if (currentRoomCode && currentRoomCode !== room.code) {
        const oldRoom = getRoom(currentRoomCode);
        if (oldRoom) handleLeave(oldRoom, playerId);
      }
      
      joinRoom(room, msg.name);
      return;
    }

    const room = currentRoomCode ? getRoom(currentRoomCode) : null;
    if (!room) return;

    switch (msg.type) {
      case "start_game": {
        const player = room.players.get(playerId);
        if (player && player.isHost) {
          const ok = startGame(room);
          if (!ok) toast(room, playerId, "need_two_players", "error");
        }
        break;
      }
      case "submit_sentence":
        submitSentence(room, playerId, msg.text);
        break;
      case "start_callout":
        startCallout(room, playerId, msg.targetId);
        break;
      case "resolve_callout":
        if (room.callout && room.callout.callerId === playerId) {
          resolveCallout(room, msg.goalId);
        }
        break;
      case "cast_vote":
        castVote(room, playerId, msg.subjectId, msg.verdict);
        break;
      case "play_again": {
        const player = room.players.get(playerId);
        if (player && player.isHost) playAgain(room);
        break;
      }
      case "leave_room":
        handleLeave(room, playerId);
        currentRoomCode = null;
        break;
    }
  });

  ws.on("close", () => {
    const room = currentRoomCode ? getRoom(currentRoomCode) : null;
    if (!room) return;
    const p = room.players.get(playerId);
    // only mark disconnected if this socket is still the "current" one for
    // that seat — an old socket closing after a reconnect shouldn't knock
    // out the new one.
    if (p && p.ws === ws) {
      p.connected = false;
      p.ws = null;
      broadcast(room);
      // clean up empty rooms after a delay
      setTimeout(() => {
        if (connectedPlayers(room).length === 0) {
          clearTurnTimer(room);
          if (room.callout?.timer) clearTimeout(room.callout.timer);
          if (room.voting?.timer) clearTimeout(room.voting.timer);
          rooms.delete(room.code);
        }
      }, 30000);
    }
  });

  function joinRoom(room, name) {
    const existing = room.players.get(playerId);

    if (existing) {
      if (existing.connected && existing.ws && existing.ws.readyState === 1 && existing.ws !== ws) {
        // Same identity is already active in this room from another tab/device.
        ws.send(JSON.stringify({ type: "error", code: "already_in_room" }));
        return;
      }
      // Reconnect: same seat, fresh socket, keep score/goal/progress.
      existing.ws = ws;
      existing.connected = true;
      if (identity.account && identity.name) existing.name = identity.name;
      if (identity.avatar) existing.avatar = identity.avatar;
      currentRoomCode = room.code;
      send(existing, { type: "joined", playerId, code: room.code });
      broadcast(room);
      return;
    }

    currentRoomCode = room.code;
    const isHost = room.players.size === 0;
    const player = {
      id: playerId,
      ws,
      name: identity.account && identity.name ? identity.name : String(name || "Player").slice(0, 18),
      avatar: identity.avatar || null,
      account: identity.account,
      connected: true,
      score: 0,
      goal: null,
      busted: false,
      isHost,
    };
    room.players.set(playerId, player);
    if (isHost) room.hostId = playerId;
    send(player, { type: "joined", playerId, code: room.code });
    broadcast(room);
  }

  function handleLeave(room, id) {
    room.players.delete(id);
    if (room.hostId === id) {
      const next = connectedPlayers(room)[0];
      if (next) {
        next.isHost = true;
        room.hostId = next.id;
      }
    }
    broadcast(room);
  }
});

server.listen(PORT, () => {
  console.log(`Derail server running on http://localhost:${PORT}`);
});
