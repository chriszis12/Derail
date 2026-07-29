// ============================================================================
// DERAIL — avatar.js
// A small, self-contained "character creator": a rounded bean-shaped body in
// a chosen color, plus a swappable hat and accessory/outfit layer. Everything
// is hand-built SVG (no external art assets), so it's cheap to render dozens
// of these in the suspect rail without any image requests.
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
];

const AVATAR_HATS = ["none", "fedora", "bowler", "cap", "tinfoil", "headband"];
const AVATAR_ACCESSORIES = ["none", "trench", "tie", "sweater", "hoodie", "scarf"];

function avatarDefault() {
  return { skin: AVATAR_SKINS[Math.floor(Math.random() * AVATAR_SKINS.length)].id, hat: "none", accessory: "none" };
}

function avatarSkinColor(skinId) {
  return (AVATAR_SKINS.find((s) => s.id === skinId) || AVATAR_SKINS[0]).color;
}

// Renders a small (viewBox 0 0 64 64) SVG string for the given config.
// `size` controls the rendered CSS box (the SVG itself always scales to fit).
function renderAvatarSVG(config, size = 40) {
  const cfg = Object.assign(avatarDefault(), config || {});
  const bodyColor = avatarSkinColor(cfg.skin);

  const bodyLayer = `
    <ellipse cx="32" cy="38" rx="17" ry="20" fill="${bodyColor}" />
    <ellipse cx="32" cy="24" rx="13" ry="12" fill="${bodyColor}" />
    <ellipse cx="26" cy="30" rx="6" ry="8" fill="rgba(255,255,255,0.55)" />
  `;

  const visorLayer = `
    <ellipse cx="34" cy="21" rx="9" ry="6" fill="#dff0f5" stroke="#1c1812" stroke-width="1" />
    <ellipse cx="36" cy="21" rx="6" ry="3.6" fill="#9fd3e8" />
  `;

  const ACCESSORY_LAYERS = {
    none: "",
    trench: `<path d="M17 34 Q32 30 47 34 L47 54 Q32 58 17 54 Z" fill="#3a352c" opacity="0.85" /><line x1="32" y1="34" x2="32" y2="56" stroke="#201c16" stroke-width="1.4" opacity="0.6" />`,
    tie: `<path d="M29 24 L35 24 L33 30 L31 30 Z" fill="#7c2420" /><path d="M30 30 L34 30 L32 46 Z" fill="#a5312b" />`,
    sweater: `<path d="M16 36 Q32 32 48 36 L48 56 Q32 60 16 56 Z" fill="#8a7237" />`,
    hoodie: `<path d="M15 33 Q32 40 49 33 L49 56 Q32 60 15 56 Z" fill="#26201a" /><path d="M20 33 Q32 24 44 33 Q32 30 20 33 Z" fill="#1c1812" />`,
    scarf: `<path d="M20 30 Q32 38 44 30 L41 40 Q32 44 23 40 Z" fill="#a5312b" /><rect x="30" y="38" width="6" height="16" rx="2" fill="#a5312b" />`,
  };

  const HAT_LAYERS = {
    none: "",
    fedora: `<ellipse cx="30" cy="14" rx="15" ry="3.4" fill="#26201a" /><path d="M20 14 Q30 1 41 8 Q36 12 30 12 Q24 12 20 14 Z" fill="#3a352c" /><rect x="22" y="10" width="14" height="2.4" fill="#a5312b" opacity="0.7" />`,
    bowler: `<ellipse cx="30" cy="13" rx="14" ry="3" fill="#1c1812" /><ellipse cx="30" cy="6" rx="9.5" ry="7.5" fill="#26201a" />`,
    cap: `<path d="M18 13 Q30 2 42 13 Z" fill="#7c2420" /><ellipse cx="30" cy="13" rx="13" ry="2.6" fill="#7c2420" /><path d="M38 13 Q46 12 46 16 Q40 16 38 14 Z" fill="#5c1815" />`,
    tinfoil: `<path d="M18 13 Q22 -1 30 -1 Q38 -1 42 13 Z" fill="#c9d3d8" stroke="#8fa0a8" stroke-width="1" /><path d="M22 6 L38 9 M21 10 L39 12" stroke="#8fa0a8" stroke-width="1" />`,
    headband: `<rect x="16" y="12" width="28" height="4" rx="2" fill="#a5312b" /><circle cx="18" cy="14" r="2.4" fill="#7c2420" />`,
  };

  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="player avatar">
    ${bodyLayer}
    ${ACCESSORY_LAYERS[cfg.accessory] || ""}
    ${visorLayer}
    ${HAT_LAYERS[cfg.hat] || ""}
  </svg>`;
}
