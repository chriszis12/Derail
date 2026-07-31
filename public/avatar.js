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

function avatarDefault() {
  return { skin: AVATAR_SKINS[Math.floor(Math.random() * AVATAR_SKINS.length)].id };
}

function avatarSkinColor(skinId) {
  return (AVATAR_SKINS.find((s) => s.id === skinId) || AVATAR_SKINS[0]).color;
}

// Returns an HTML string for a small colored dot avatar. Kept as a function
// (rather than just reading .color directly everywhere) so every call site
// stays untouched if avatars ever grow a second attribute later.
function renderAvatarSVG(config, size = 40) {
  const cfg = Object.assign(avatarDefault(), config || {});
  const color = avatarSkinColor(cfg.skin);
  return `<span class="avatar-dot" style="width:${size}px;height:${size}px;background:${color};"></span>`;
}
