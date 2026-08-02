// ============================================================================
// DERAIL — local-auth.js
// Username/password accounts for anyone who doesn't want to set up Google/
// Discord/GitHub OAuth apps. Always available, no env vars required.
//
// Passwords are hashed with Node's built-in crypto.scrypt (no extra
// dependency, no native bindings to worry about) — the plaintext password
// is never stored, only a salted hash of it.
//
// Accounts live in a flat JSON file (data/users.json), loaded into memory
// and rewritten on every change. That's plenty for a small deployment; if
// this ever needs to survive across multiple server instances or handle
// serious signup volume, swap this file for a real database instead.
// ============================================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

let users = {}; // usernameLower -> { username, name, passwordHash, salt, createdAt }

function load() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
  } catch {
    users = {};
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("[derail] failed to persist local accounts:", err.message);
  }
}

load();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function validUsername(name) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(name);
}

function register(username, password) {
  const key = username.toLowerCase();
  if (!validUsername(username)) return { error: "invalid_username" };
  if (!password || password.length < 6) return { error: "weak_password" };
  if (users[key]) return { error: "username_taken" };

  const salt = crypto.randomBytes(16).toString("hex");
  users[key] = {
    username,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: Date.now(),
  };
  save();
  return { user: toIdentity(users[key]) };
}

function login(username, password) {
  const key = String(username || "").toLowerCase();
  const record = users[key];
  if (!record) return { error: "not_found" };
  const hash = hashPassword(password || "", record.salt);
  // Constant-time compare to avoid leaking timing info about the hash.
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(record.passwordHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { error: "wrong_password" };
  }
  return { user: toIdentity(record) };
}

function toIdentity(record) {
  return {
    provider: "local",
    identityId: `local:${record.username.toLowerCase()}`,
    name: record.username,
    avatar: null,
  };
}

module.exports = { register, login };
