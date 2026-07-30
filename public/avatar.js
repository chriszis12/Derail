// ============================================================================
// DERAIL — avatar.js
// Character rendering built from real image parts (public/avatar-parts/),
// not drawn shapes. Layering: body (fixed) -> head (the only part that gets
// recolored, via a CSS mask) -> hat (fixed, one of a few choices).
//
// Why a mask instead of just tinting the PNG in JS: the head part is meant
// to be a plain silhouette, so `mask-image: url(head.png)` + a background
// color gives a crisp, exact recolor with zero canvas/pixel work and no
// extra requests. See public/avatar-parts/README.txt for the exact files
// this expects.
// ============================================================================

const AVATAR_PARTS_PATH = "avatar-parts/";

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

const AVATAR_HATS = ["none", "cap", "fedora", "beanie"];

// Small per-hat nudge knobs, in case the source images don't perfectly line
// up once dropped in. 1 = full frame, 0/0 = no offset. Tweak by eye.
const AVATAR_HAT_TRANSFORMS = {
  none: { scale: 1, x: 0, y: 0 },
  cap: { scale: 1, x: 0, y: 0 },
  fedora: { scale: 1, x: 0, y: 0 },
  beanie: { scale: 1, x: 0, y: 0 },
};

function avatarDefault() {
  return { skin: AVATAR_SKINS[Math.floor(Math.random() * AVATAR_SKINS.length)].id, hat: "none" };
}

function avatarSkinColor(skinId) {
  return (AVATAR_SKINS.find((s) => s.id === skinId) || AVATAR_SKINS[0]).color;
}

// Returns an HTML string (not raw SVG despite the name — kept so every
// existing call site that does `.innerHTML = renderAvatarSVG(cfg, size)`
// keeps working unchanged) for the given avatar config.
function renderAvatarSVG(config, size = 40) {
  const cfg = Object.assign(avatarDefault(), config || {});
  const color = avatarSkinColor(cfg.skin);
  const hatId = AVATAR_HATS.includes(cfg.hat) ? cfg.hat : "none";
  const hatT = AVATAR_HAT_TRANSFORMS[hatId] || AVATAR_HAT_TRANSFORMS.none;

  const bodyUrl = AVATAR_PARTS_PATH + "body.png";
  const headUrl = AVATAR_PARTS_PATH + "head.png";
  const hatUrl = hatId === "none" ? null : AVATAR_PARTS_PATH + "hat-" + hatId + ".png";

  const hatLayer = hatUrl
    ? `<img class="avatar-layer avatar-hat" src="${hatUrl}" alt=""
         style="transform: translate(${hatT.x}%, ${hatT.y}%) scale(${hatT.scale});"
         onerror="this.remove()" />`
    : "";

  // The figure's own background is the fallback: if body.png 404s (e.g. the
  // real asset files haven't been dropped into avatar-parts/ yet), the img
  // tag removes itself on error and this tinted circle shows through instead
  // of a broken-image icon.
  return `<span class="avatar-figure" style="width:${size}px;height:${size}px;background:${color};">
    <img class="avatar-layer avatar-body" src="${bodyUrl}" alt=""
      onerror="this.remove()" />
    <span class="avatar-layer avatar-head" style="background-color:${color};
      -webkit-mask-image:url('${headUrl}'); mask-image:url('${headUrl}');"></span>
    ${hatLayer}
  </span>`;
}
