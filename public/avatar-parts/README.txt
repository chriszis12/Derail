Drop your character part images in this folder with these exact filenames.
Nothing else in the code needs to change once they're here.

  body.png        the black suit body (fixed, never recolored)
  head.png        the plain white/silhouette head shape — this ONE gets tinted
                   per-player using CSS masking, so it must be a solid white
                   (or solid black) shape on a transparent background, not a
                   flat photo. If your source image has shading/gradients,
                   flatten it to a single-color silhouette first (any image
                   editor's "threshold" or "select by color -> fill" tool
                   works in a few seconds).
  hat-cap.png      baseball-style cap
  hat-fedora.png   fedora
  hat-beanie.png   beanie

Sizing: export every file on the SAME square canvas (e.g. 512x512px),
transparent background, with the part positioned where it should sit
relative to the others (so the hat is already roughly where a hat should
sit above the head, etc.) — the game just stacks these files directly on
top of each other at 100% width/height, it does not auto-align them.

If a hat sits slightly off after you drop it in, don't re-export the whole
image — there are small per-hat nudge values (scale/offsetX/offsetY) right
at the top of public/avatar.js (AVATAR_HAT_TRANSFORMS) you can tweak instead.

Until real files are placed here, the game falls back to a plain colored
circle so nothing looks broken — see the "fallback" note in avatar.js.
