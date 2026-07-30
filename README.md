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

## 4. Accounts: Google / Discord / GitHub login

Login is **entirely optional and off by default** — the game works fine with
just guest names. Each provider's button only appears once you've configured
that provider's credentials as environment variables. Nothing here ever
stores a password: identity is 100% delegated to the provider, and the
account record is just `{ provider, id, name, avatar }` living inside a
signed, `httpOnly` session cookie (see the encryption/security section below
for exactly what "signed" means here).

For each provider you want to enable, you register an OAuth app on that
provider's developer console, get a **client ID** and **client secret**, and
set them as environment variables (the same panel you saw on Render's
deploy screen: **Environment Variables**). You also need a `SESSION_SECRET`
regardless of whether you use OAuth at all.

| Variable | Where to get it |
|---|---|
| `SESSION_SECRET` | any long random string, e.g. generate one with `openssl rand -hex 32` |
| `PUBLIC_URL` | your deployed URL, e.g. `https://derail.onrender.com` (no trailing slash) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console → Credentials → OAuth client ID → Web application → Authorized redirect URI: `PUBLIC_URL/auth/google/callback` |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord Developer Portal → New Application → OAuth2 → Redirect: `PUBLIC_URL/auth/discord/callback` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub Developer Settings → New OAuth App → Authorization callback URL: `PUBLIC_URL/auth/github/callback` |

You can enable zero, one, two, or all three — `auth.js` only registers a
provider (and the client only shows its button) if both its env vars are set.

## 5. Security notes (read this if "encryption" is why you're here)

A few things worth being precise about:

- **No passwords are ever stored**, anywhere, for OAuth logins — auth is
  fully delegated to Google/Discord/GitHub. There's nothing to crack because
  there's nothing kept.
- **The session cookie is signed** with `SESSION_SECRET` (via
  `express-session`), marked `httpOnly` (JavaScript in the browser can't read
  it, which blocks most cookie-theft-via-XSS attacks) and `secure` in
  production (only sent over `https://`). Signing means the server can detect
  if a cookie was tampered with — it's not the same as "encrypting the code,"
  it's how the server verifies *this cookie is really the one I issued*.
- **Transport encryption (HTTPS/WSS) comes from your host**, not from this
  code. Render, Railway, and Fly.io all terminate TLS for you automatically
  on their domains — that's what actually encrypts traffic between a
  player's browser and your server. Nothing to configure.
- **Client-side JavaScript cannot be truly "encrypted."** Anything sent to a
  browser to execute can always be read via "View Source" or dev tools —
  that's true for every website, including this one, no matter how it's
  minified or obfuscated. Minifying/obfuscating raises the effort to read it,
  but it is a speed bump, not a lock. If you want, a minification build step
  (e.g. esbuild) can be added before deploying, but it's a deterrent, not
  real protection, and makes the code harder for you to debug too.
- **Rate limiting / abuse protection isn't built in.** For a private game
  night with a link you share yourself, this is fine. If you're putting the
  room-code join flow somewhere public, consider adding a rate limiter
  (e.g. express-rate-limit) in front of `/auth/*` and the WebSocket upgrade.

## 5b. Duplicate-join prevention

Each browser session gets one identity: your OAuth account if you're logged
in (so the same Google/Discord/GitHub account can never hold two seats in one
room, even from two different browsers), or a random guest ID stashed in your
session cookie if you're not (so refreshing the page or opening a second tab
reconnects you to your existing seat instead of creating a new player). If
you try to open the *same* room in a genuinely different tab while your
first tab is still connected, you'll get an "already in this room" message
instead of a duplicate seat.

## 6. What's new in this pass

- **Credits fixed** — the footer is now `position: fixed` at the bottom of
  every screen (it was previously just below the fold on taller pages), so
  "a browser game by Christos Zisopoulos of Spaceland Studios Games" is
  always visible.
- **One settings menu** (⚙ top-right, all screens) replacing scattered
  controls: a proper language *menu* (not a native dropdown) with flags for
  English / Greek / Spanish, separate sound-effects and music toggles with
  their own volume sliders, a "reduce motion" toggle for accessibility, and
  a "forget my saved settings" reset button.
- **Background music** — a slow, moody, procedurally-generated chord
  progression (`public/music.js`) fitting the noir/case-file mood. Like the
  sound effects, it's synthesized live via the Web Audio API, so there's no
  audio file to host or license. Muted by default until you opt in from
  Settings (browsers block autoplay audio until a real click happens anyway).
- **Animations:** story lines fade in as they're added, the suspect rail and
  scoreboard stagger in, screens cross-fade on transition, the timer bar
  pulses red in the final seconds, and the BUSTED/NOT QUITE rubber-stamp
  slams down with a little overshoot. All of it respects the "reduce motion"
  setting and the OS-level `prefers-reduced-motion` flag.
- **Settings persistence:** name, language, sound/music mute + volume, and
  motion preference all live in `localStorage` and restore on your next visit.
- **Languages:** English, Greek (Ελληνικά), and Spanish (Español) for all UI
  chrome, buttons, and toast messages. Scenario/goal *content* stays in
  English for now (see `i18n.js` for where to add more).

## 7. Host-configurable match settings

From the lobby, the host gets a **match settings** panel (everyone else sees
a plain-language summary instead) covering:

- **Language** — English, Greek, or Spanish. This isn't just the UI: the
  opening scenario, all 21 secret goals, and the banned-word list are fully
  translated and swapped per match, not just menu labels.
- **Turn timer** — 10 / 15 / 20 / 30 seconds per sentence.
- **Rounds** — 6 / 8 / 10 / 14 / 20 total sentences before the reveal.
- **Trojan horse goal** — auto (only dealt with 3+ players, same as before),
  always include, or never.
- **Word bans ("chaos")** — off, normal (2 banned words), or chaos (4).
- **Public** — lists the room for matchmaking (see below). Off by default;
  a room with a code is private by default even with this off.

Settings can only be changed while still in the lobby and only by the host.

## 8. Matchmaking ("quick match")

The home screen has a **quick match** button next to "start a new file". It
looks for an existing public, not-yet-started room with fewer than 8 players
(preferring one already set to your current UI language), and joins it. If
nothing fits, it creates a fresh public room for the next person to land in.
There's no skill-based or region-based matching — it's a simple "first open
public seat" queue, which is honestly all a private party game needs, but
worth knowing if you were picturing an ELO system.

## 9. Player-name censoring

Names are checked against a short, common-terms blocklist (see
`NAME_BLOCKLIST` in `server.js`) and any match gets everything after its
first letter replaced with asterisks (`fuck` → `f***`). This applies **only**
to display names — never to the sentences players write into the story,
since filtering the actual gameplay text would gut the whole joke of the
game. It's a lightweight substring filter, not a comprehensive moderation
system: obvious misspellings/leetspeak (`fu(k`, `ffuuuck`) will slip past it.
Swap in a proper library (e.g. `bad-words` or `obscenity`) in `censorName()`
if you need something sturdier for a public deployment.

## 10. Character avatars

Characters are built from **real image parts**, not drawn shapes — three
layers stacked per player: a fixed body, a head that gets tinted to the
player's chosen color, and an optional hat.

**You need to supply the actual image files.** They go in
`public/avatar-parts/` with these exact filenames:

| File | What it is |
|---|---|
| `body.png` | the suit body — fixed, same for every player |
| `head.png` | a plain silhouette (solid white or black shape, transparent background) — this is the **only** recolorable part |
| `hat-cap.png`, `hat-fedora.png`, `hat-beanie.png` | the three hat choices (plus "none") |

Until those files are in place, a player's character just shows as a plain
colored circle in their chosen color — nothing breaks, it just looks
minimal, so you can ship and test everything else first and drop the art in
whenever it's ready.

**Why only the head is recolorable, and how:** the head layer uses CSS
`mask-image` — the browser uses `head.png`'s alpha channel as a stencil and
paints the chosen color through it. That only works cleanly if `head.png`
is a flat silhouette; a shaded/gradient head photo will mask oddly (patchy
color instead of a clean fill). If your source head image has shading,
flatten it to one solid color first (most image editors call this
"threshold" or "select by color → fill").

**On why I didn't just fetch and bundle image links you point me to:** I
don't download and embed third-party images (product photos, stock hat
photography, etc.) into a project I'm handing you, since I have no way to
know their license. That's not a limitation of the code — the layered
system above works with *any* PNGs you provide, your own art included. Full
notes on exact sizing/alignment are in `public/avatar-parts/README.txt`, and
`AVATAR_HAT_TRANSFORMS` near the top of `public/avatar.js` has small nudge
values (scale/x/y per hat) in case a hat needs a small manual offset once
you see it rendered against your specific body/head art.

## 11. Better invite links

Opening a `?join=CODE` link now: prefills and cleans up the URL, shows a
"joining room XXXX" banner, focuses the name field so there's exactly one
thing left to do, and lets you hit Enter in the name field to jump straight
into the join (or create a room, if no code is present). The "copy invite
link" button uses the native share sheet on mobile (`navigator.share`) when
available, falling back to clipboard-copy everywhere else.

## 12. Tuning the game

Everything that controls game feel lives at the top of `server.js`:

- `TURN_SECONDS` — how long each player gets to write (default 15s)
- `MAX_ROUNDS` — total sentences before the story ends (default 10)
- `GAME_TIME_LIMIT_MS` — hard backstop timer (default 3 min)
- `VOTE_SECONDS` / `CALLOUT_SECONDS` — timers for the verdict and accusation phases
- `SCENARIOS` — the pool of opening lines
- `GOAL_POOL` — the pool of secret objectives (the one with `trojan: true` is
  the "stay normal" objective, only dealt in games of 3+ players)
- `BANNED_WORD_POOL` — words the engine can randomly redact for a round

**Important:** if you edit `GOAL_POOL_BY_LANG` in `server.js`, also update the
mirrored `GOAL_POOL_CLIENT_BY_LANG` object near the top of `public/client.js`
— that copy is what lets an accuser pick a guess from a multiple-choice list
client-side without the server leaking every player's goal to everyone. Same
goes for `SCENARIOS_BY_LANG` and `BANNED_WORD_POOL_BY_LANG` if you add a
fourth language — the client-side callout picker doesn't need those two, only
the goal pool.

## 13. Known scope / what's not built

- No persistent leaderboard or match history across sessions — scores reset
  whenever "start a new file" is pressed, and nothing survives a server
  restart (OAuth accounts identify you, but don't carry stats anywhere).
- Matchmaking is "first open public room," not skill- or region-based.
- The name censor is a simple substring blocklist — obvious leetspeak/spacing
  tricks will get through (see section 9).
- Avatars need real image files dropped into `public/avatar-parts/` (see
  section 10) — the code ships ready for them but doesn't include any art.
- Scenario/goal *content* is translated for English/Greek/Spanish; adding a
  fourth language means writing a new content pool, not just UI strings.
- Designed for roughly 2–8 players per room; there's no hard cap enforced.
