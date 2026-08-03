// ============================================================================
// DERAIL — avatar.js
// Player "avatars" are just a colored dot — no character art to maintain,
// nothing to draw or source. Kept as its own tiny module (rather than inlined
// in client.js) so the color list is one obvious place to edit.
// ============================================================================

const AVATAR_SKINS = [
  { id: "crimson", color: "#a5312b" },
  { id: "amber", color: "#b48f3d" },
  { id: "moss", color: "#4b7a5c" },
  { id: "steel", color: "#5c7a96" },
  { id: "plum", color: "#7a4b74" },
  { id: "ink", color: "#3a352c" },
  { id: "bone", color: "#d8cba3" },
  { id: "rust", color: "#c9702e" },
  { id: "teal", color: "#3f8f88" },
  { id: "rose", color: "#c46a86" },
];

// Cosmetic-only, no gameplay effect whatsoever — see README for how these
// tie into Stripe. `sku` must match the metadata.sku set on the Stripe
// Checkout session / Payment Link that unlocks it.
const AVATAR_SKINS_PREMIUM = [
  { id: "gold-foil", color: "#d4af37", sku: "cosmetic_gold_foil" },
  { id: "chrome", color: "#b8c4cc", sku: "cosmetic_chrome" },
  { id: "emerald", color: "#2f8f5b", sku: "cosmetic_emerald" },
  { id: "violet-neon", color: "#9b4fe0", sku: "cosmetic_violet_neon" },
];

function avatarDefault() {
  return { skin: AVATAR_SKINS[Math.floor(Math.random() * AVATAR_SKINS.length)].id };
}

function avatarSkinColor(skinId) {
  const found = [...AVATAR_SKINS, ...AVATAR_SKINS_PREMIUM].find((s) => s.id === skinId);
  return (found || AVATAR_SKINS[0]).color;
}

// Returns an HTML string for a small colored dot avatar. Kept as a function
// (rather than just reading .color directly everywhere) so every call site
// stays untouched if avatars ever grow a second attribute later.
function renderAvatarSVG(config, size = 40) {
  const cfg = Object.assign(avatarDefault(), config || {});
  const color = avatarSkinColor(cfg.skin);
  return `<span class="avatar-dot" style="width:${size}px;height:${size}px;background:${color};"></span>`;
}
