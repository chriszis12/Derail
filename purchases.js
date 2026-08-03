// ============================================================================
// DERAIL — purchases.js
// Tracks which cosmetic SKUs each account has unlocked. Same flat-JSON
// pattern as local-auth.js/stats.js — fine for a small deployment, swap for
// a real database if this ever needs to survive multiple server instances.
//
// This file only tracks *entitlements*, not payments. The actual charging
// happens entirely on Stripe's side (Payment Links or Checkout) — this file
// just gets told "identityId X paid for SKU Y" by the Stripe webhook handler
// in server.js and remembers it. No card data, no payment details, ever
// touch this app directly.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const PURCHASES_FILE = path.join(DATA_DIR, "purchases.json");

let purchases = {}; // identityId -> [sku, sku, ...]

function load() {
  try {
    if (fs.existsSync(PURCHASES_FILE)) {
      purchases = JSON.parse(fs.readFileSync(PURCHASES_FILE, "utf8"));
    }
  } catch {
    purchases = {};
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PURCHASES_FILE, JSON.stringify(purchases, null, 2));
  } catch (err) {
    console.error("[derail] failed to persist purchases:", err.message);
  }
}

load();

function grant(identityId, sku) {
  if (!identityId || identityId.startsWith("guest:")) return; // guests can't own anything persistent
  const owned = purchases[identityId] || [];
  if (!owned.includes(sku)) owned.push(sku);
  purchases[identityId] = owned;
  save();
}

function getEntitlements(identityId) {
  return purchases[identityId] || [];
}

module.exports = { grant, getEntitlements };
