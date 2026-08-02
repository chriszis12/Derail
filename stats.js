// ============================================================================
// DERAIL — stats.js
// A leaderboard for accounts only — guest players are intentionally never
// recorded here, since a guest's identity resets the moment their session
// cookie clears and a leaderboard entry for "Player" that isn't really
// trackable wouldn't mean anything.
//
// Same pattern as local-auth.js: a flat JSON file, loaded into memory,
// rewritten on change. Fine for a small deployment; swap for a real
// database if this ever needs to survive multiple server instances.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

let stats = {}; // identityId -> { name, gamesPlayed, wins, totalScore, lastPlayed }

function load() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    }
  } catch {
    stats = {};
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error("[derail] failed to persist stats:", err.message);
  }
}

load();

/**
 * @param {Array<{identityId:string, name:string, score:number, won:boolean}>} players
 *   Only players with a real account (identityId not starting with "guest:")
 *   should be passed in — filter before calling this.
 */
function recordGame(players) {
  for (const p of players) {
    if (!p.identityId || p.identityId.startsWith("guest:")) continue;
    const entry = stats[p.identityId] || {
      name: p.name,
      gamesPlayed: 0,
      wins: 0,
      totalScore: 0,
      lastPlayed: 0,
    };
    entry.name = p.name; // keep display name fresh in case they renamed
    entry.gamesPlayed += 1;
    entry.totalScore += p.score;
    if (p.won) entry.wins += 1;
    entry.lastPlayed = Date.now();
    stats[p.identityId] = entry;
  }
  save();
}

function getLeaderboard(limit = 20) {
  return Object.entries(stats)
    .map(([identityId, s]) => ({ identityId, ...s }))
    .sort((a, b) => b.wins - a.wins || b.totalScore - a.totalScore)
    .slice(0, limit);
}

module.exports = { recordGame, getLeaderboard };
