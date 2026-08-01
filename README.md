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

Kept intentionally simple now: each player is just a colored dot, picked
from 10 colors on the home screen. No art to source, host, or maintain,
nothing to break.

## 11. AI-judged voting (optional, needs a Gemini API key)

Peer voting has an obvious problem: people vote however they want, including
"bullshit" votes for a friend who obviously didn't hit their goal. As an
alternative, the host can flip on **AI judge** in the match settings panel —
instead of a player vote, one Gemini call reads the whole finished story and
rules on every player's secret goal at once (one call per game, not one per
player, to keep usage sane across many simultaneous rooms).

**Setup:** get an API key at aistudio.google.com/apikey, then set it as an
environment variable — `GEMINI_API_KEY` — the same way you set the OAuth
secrets (Render → your service → Environment). The toggle only appears
usable once the server has a key; otherwise it's shown disabled with a hint
explaining why. **Never put the actual key value in a committed file** —
`ai-judge.js` only ever reads it from `process.env.GEMINI_API_KEY`.

If AI judging is on but every model call fails (bad/missing key, Google's
API is down, quota exhausted), the game automatically falls back to the
original peer-voting flow rather than getting stuck — this feature can never
hard-break a match, only degrade to what was there before.

`ai-judge.js` tries a short list of Gemini model tiers in order
(`GEMINI_MODELS` at the top of that file) so one model being rate-limited
doesn't take the feature down. Google renames/retires models occasionally —
if this stops working, check ai.google.dev/gemini-api/docs/models and
update that list.

## 12. Ads (Google AdSense)

The AdSense script tag and three ad slots (home screen, lobby, and reveal
screen — deliberately not during active writing, so an ad never sits next
to a 15-second timer) are wired in. Two things you still need to do:

1. In your AdSense dashboard, create an ad unit and copy its **slot ID**,
   then replace `data-ad-slot="0000000000"` in `public/index.html` (three
   occurrences) with the real value.
2. `public/ads.txt` already has your publisher ID
   (`ca-pub-7313911947751437`) in the format AdSense requires — it's served
   automatically at `yourdomain.com/ads.txt` once deployed, which AdSense
   checks as part of approving your site.

Ads won't actually render until Google approves the site (usually needs a
live, populated, publicly-reachable domain — not localhost), and won't show
for anyone running an ad blocker; both are expected, the slot just quietly
stays empty.

## 13. Basic abuse protection

Now that this is meant for public traffic: each IP is capped at 20
create/join/quick-match actions per 5 minutes, and each connection is capped
at 15 messages/second (silently dropped past that, not an error) to blunt
naive spam. Both live in `server.js` near the top of the WebSocket section
and are in-memory only — fine for one server instance; move these counters
to something shared like Redis if you ever scale to multiple instances.

## 14. Before you actually promote this publicly

- **Privacy policy**: `public/privacy.html` is a starting template covering
  what the code actually collects (OAuth profile data, gameplay state,
  AdSense cookies, the Gemini API call if AI judging is on) — fill in the
  bracketed placeholders and get it reviewed; I'm not a lawyer and this
  isn't legal advice, just an accurate technical starting point. It's
  linked from the footer on every screen.
- **`SESSION_SECRET`**: set this in production (section 4) or every login
  gets forgotten whenever the server restarts.
- **Test on the real domain** before going public: OAuth redirect URIs,
  AdSense approval, and `ads.txt` all depend on the final URL, not localhost.

## 15. Launch polish (PWA, security headers, and a few engagement touches)

- **Installable (PWA)**: `manifest.json` + real generated icons in
  `public/icons/` — players can "Add to Home Screen" on phone or desktop for
  a fullscreen, app-like launch. iOS-specific meta tags handle the
  fullscreen-without-browser-chrome behavior Apple needs separately from the
  manifest.
- **Content-Security-Policy** meta tag restricts scripts/styles/connections
  to an explicit allowlist (self + the AdSense/Google domains this app
  actually needs). It includes `'unsafe-inline'` for styles because a lot of
  the UI sets inline `style=""` (timer bars, colored avatar dots) — removing
  that would need a nonce-based rewrite, a bigger change than a meta tag.
  Still meaningfully blocks scripts loading from any domain not listed.
- **Canonical URL**: `<link rel="canonical">` currently points at a
  placeholder — **replace it with your real deployed domain** before launch,
  or it actively confuses search engines instead of helping.
- **`<noscript>` fallback** tells anyone with JS disabled/blocked why the
  page looks broken instead of just silently failing.
- **Streamer mode**: the room code is hidden by default everywhere it's
  shown (lobby, game, voting, reveal) — click the eye icon next to it to
  reveal. Protects against stream snipers without you having to think about it.
- **Turn "typing" indicator**: whoever's turn it is gets a bouncing avatar
  and animated dots in the suspect rail instead of just a static highlight.
- **Tension audio**: the timer's tick now starts at 5 seconds left (was 3)
  and climbs in pitch as it counts down; a Derail callout now shakes the
  screen briefly when it opens.
- **Host custom scenario**: the match settings panel has an optional
  "custom opening line" field — leave it blank for the usual random
  scenario, or type your own to build in an inside joke for your specific
  group. Overrides the random pool for that match only.

## 16. Tuning the game

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

## 17. Known scope / what's not built

- No persistent leaderboard or match history across sessions — scores reset
  whenever "start a new file" is pressed, and nothing survives a server
  restart (OAuth accounts identify you, but don't carry stats anywhere).
- Matchmaking is "first open public room," not skill- or region-based.
- The name censor is a simple substring blocklist — obvious leetspeak/spacing
  tricks will get through (see section 9).
- Avatars are color-only by design now — no character art at all.
- AI judging is one call per game, not per player, but still costs real
  Gemini quota/tokens per finished match — keep an eye on usage if this gets
  real traffic.
- Scenario/goal *content* is translated for English/Greek/Spanish; adding a
  fourth language means writing a new content pool, not just UI strings.
- Designed for roughly 2–8 players per room; there's no hard cap enforced.
