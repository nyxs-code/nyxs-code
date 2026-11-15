// make-colors.js: copy this file into your mod's hooks folder and leave it as it is.
// Turns a few anchor colors into the palette `$.theme.set({ colors })` takes: the design
// system's scale names, which Nyxs and Claude Code both read. A color you leave out stays the
// app's own.

const HEX = /^#[0-9a-f]{6}$/i;

// Where each anchor sits on the scale: [light, dark].
const ANCHORS = {
  "surface-0": ["gray-20", "gray-900"],
  "surface-1": ["gray-10", "gray-850"],
  "surface-2": ["gray-0", "gray-830"],
  "surface-3": ["gray-0", "gray-800"],
  "text-primary": ["gray-900", "gray-50"],
  "text-secondary": ["gray-600", "gray-200"],
  "text-muted": ["gray-400", "gray-400"],
};

// A role's fill, and the shade its text takes in light and in dark.
const ROLE_TEXT = { accent: [600, 300], danger: [600, 300], success: [600, 400], warning: [600, 300], pro: [600, 300] };

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function mix(a, b, t) {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

function check(where, hex) {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new Error(`${where}: "${hex}" is not a six-digit hex color such as #1e1e2e`);
  return hex.toLowerCase();
}

/**
 * makeColors({ label, roles?, light?: { gray: { anchors }, roles?, git? }, dark?: …, codeTheme?, contrast? })
 * → { theme, problems }: `theme` goes to `$.theme.set({ colors: theme })`; `problems` lists text
 * that reads poorly on its surface.
 */
export function makeColors(spec) {
  if (!spec || typeof spec.label !== "string" || !spec.label) throw new Error("makeColors needs a label");
  if (spec.git) throw new Error("git colors go inside a mode: light: { git: { added: '#2d8a4e' } }");
  const inputs = {};
  const problems = [];
  for (const mode of ["light", "dark"]) {
    const m = spec[mode];
    if (!m) continue;
    const i = mode === "light" ? 0 : 1;
    const anchors = (m.gray && m.gray.anchors) || {};
    if (!anchors["surface-0"] || !anchors["text-primary"]) throw new Error(`${mode}: surface-0 and text-primary are required`);
    const out = {};
    for (const [name, hex] of Object.entries(anchors)) {
      if (!(name in ANCHORS)) throw new Error(`${mode}: "${name}" is not an anchor (${Object.keys(ANCHORS).join(", ")})`);
      out[ANCHORS[name][i]] = check(`${mode}.${name}`, hex);
    }
    const roles = { ...(spec.roles || {}), ...(m.roles || {}) };
    for (const [role, hex] of Object.entries(roles)) {
      if (!(role in ROLE_TEXT)) throw new Error(`"${role}" is not a role (${Object.keys(ROLE_TEXT).join(", ")})`);
      const c = check(`roles.${role}`, hex);
      out[`role-${role}-fill`] = c;
      out[`role-${role}-fill-hover`] = mode === "light" ? mix(c, "#000000", 0.12) : mix(c, "#ffffff", 0.15);
      out[`role-${role}-${ROLE_TEXT[role][i]}`] = c;
    }
    for (const [kind, hex] of Object.entries(m.git || {})) out[`text-git-${kind}`] = check(`${mode}.git.${kind}`, hex);
    const page = anchors["surface-0"];
    const say = (what, a, b, need) => {
      const r = contrast(a, b);
      if (r < need) problems.push(`${what} is ${r.toFixed(2)}:1 in ${mode} mode; it needs ${need}:1`);
    };
    say("text-primary on surface-0", anchors["text-primary"], page, 7);
    if (anchors["text-muted"]) say("text-muted on surface-0", anchors["text-muted"], page, 4.5);
    if (anchors["surface-2"]) say("text-primary on surface-2", anchors["text-primary"], anchors["surface-2"], 7);
    inputs[mode] = out;
  }
  if (!inputs.light && !inputs.dark) throw new Error("makeColors needs light, dark or both");
  const theme = { v: 1, id: spec.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: spec.label.slice(0, 64), inputs };
  if (spec.codeTheme) theme.codeTheme = spec.codeTheme;
  if (spec.contrast === "more") theme.contrast = "more";
  return { theme, problems };
}
