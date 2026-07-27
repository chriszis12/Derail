# Derail

A real-time collaborative storytelling party game. Everyone writes one shared
story — but everyone has a different, ridiculous secret goal they're trying to
sneak into it before anyone notices.

Tech: plain HTML/CSS/JS on the client, Node.js + Express + `ws` on the server.
No database, no build step. All game state lives in server memory per room.

## Project layout

```
derail-game/
├── server.js          the whole game engine + WebSocket + static server
├── package.json
└── public/
    ├── index.html
    ├── style.css
    └── client.js
```

## 1. Run it locally

```bash
npm install
npm start
```

Open `http://localhost:8080` in a browser tab. Open a second tab (or send the
link to a friend on the same network) to test with multiple players.

To let people on your same WiFi join without deploying anywhere:
1. Find your machine's local IP (`ipconfig getifaddr en0` on Mac, `ipconfig` on
   Windows, `hostname -I` on Linux).
2. Share `http://YOUR_LOCAL_IP:8080` instead of `localhost`.

## 2. How the online multiplayer actually works

- The client opens a single WebSocket connection to the same host that served
  the page (`wss://` on https, `ws://` on http — handled automatically in
  `client.js`).
- `create_room` / `join_room` messages get you into a 4-character room, e.g. `F32C`.
- From then on, the **server is the only source of truth**. Every action
  (writing a sentence, hitting DERAIL, voting) is sent to the server; the
  server validates it, updates the room, and re-broadcasts the *entire* room
  state to every connected player in that room. The client never trusts its
  own local state — it just renders whatever the server last sent.
- This means: no client-side cheating on secret goals (goals are only ever
  sent to the player who owns them), the server enforces turn order and the
  15s timer, and reconnects are simple because the server just resends full
  state on every change.
- Rooms are pure in-memory objects (a `Map`) — restarting the server wipes
  all active rooms. That's fine for a party game; add Redis if you ever need
  rooms to survive a server restart or to run more than one server process.

## 3. Put it online for real (pick one)

Any host that can run a persistent Node.js process + WebSockets works. Static
hosts like GitHub Pages/Netlify/Vercel's default tier do **not** work for this,
because they can't hold a WebSocket server or in-memory room state — you need
a real, always-on Node process.

### Render.com (easiest, free tier available)
1. Push this folder to a GitHub repo.
2. On Render: **New → Web Service** → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Deploy. Render gives you an `https://your-app.onrender.com` URL —
   WebSockets work out of the box over `wss://`.

### Railway.app
1. Push to GitHub, then **New Project → Deploy from GitHub repo** on Railway.
2. It auto-detects Node, runs `npm install && npm start`. No extra config needed.
3. Generate a public domain in the service's Settings tab.

### Fly.io
1. `fly launch` in this folder (it'll detect Node and generate a `Dockerfile`/`fly.toml`).
2. `fly deploy`.
3. Fly's proxy supports WebSockets natively.

### Quick "just show a friend right now" option: ngrok
```bash
npm start
# in a second terminal:
ngrok http 8080
```
ngrok gives you a temporary public `https://xxxx.ngrok-free.app` URL that
tunnels straight to your local server — good for a one-off game night, not a
permanent link.

No matter which host, the client code doesn't change — it always connects to
`location.host`, so whatever domain serves the page is also the WebSocket
endpoint.

## 4. Tuning the game

Everything that controls game feel lives at the top of `server.js`:

- `TURN_SECONDS` — how long each player gets to write (default 15s)
- `MAX_ROUNDS` — total sentences before the story ends (default 10)
- `GAME_TIME_LIMIT_MS` — hard backstop timer (default 3 min)
- `VOTE_SECONDS` / `CALLOUT_SECONDS` — timers for the verdict and accusation phases
- `SCENARIOS` — the pool of opening lines
- `GOAL_POOL` — the pool of secret objectives (the one with `trojan: true` is
  the "stay normal" objective, only dealt in games of 3+ players)
- `BANNED_WORD_POOL` — words the engine can randomly redact for a round

**Important:** if you edit `GOAL_POOL` in `server.js`, also update the mirrored
`GOAL_POOL_CLIENT` array near the top of `public/client.js` — that copy is what
lets an accuser pick a guess from a multiple-choice list client-side without
the server leaking every player's goal to everyone.

## 5. Known scope / what's not built

- No accounts, no persistent leaderboard across sessions — scores reset on
  "start a new file" only if you press it, but never survive a server restart.
- No profanity filter on free-text sentences beyond the banned-word mechanic.
- Designed for roughly 2–8 players per room; there's no hard cap enforced.
