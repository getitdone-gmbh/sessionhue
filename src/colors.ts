export type RGB = { r: number; g: number; b: number };

/**
 * Built-in palette. Every color reaches WCAG AAA (7:1) against black tab text,
 * so a label on top of the indicator stays readable. Any #hex works too and is
 * checked (and, if needed, adjusted) the same way.
 */
export const PALETTE: Record<string, string> = {
  red: "#ff9592",
  orange: "#ffa057",
  amber: "#ffca16",
  green: "#3dd68c",
  teal: "#0bd8b6",
  cyan: "#4ccce6",
  blue: "#70b8ff",
  indigo: "#9eb1ff",
  purple: "#d19dff",
  pink: "#ff8dcc",
  brown: "#dbb594",
  gray: "#b5b5b5",
};

/** Friendly aliases (incl. German) so `sessionhue set rot` just works. */
const ALIASES: Record<string, string> = {
  rot: "red",
  gelb: "amber",
  yellow: "amber",
  gruen: "green",
  grün: "green",
  tuerkis: "teal",
  türkis: "teal",
  blau: "blue",
  lila: "purple",
  violet: "purple",
  rosa: "pink",
  braun: "brown",
  grau: "gray",
  grey: "gray",
};

export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: RGB): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** Resolves a palette name, alias or hex string to a normalized #rrggbb. */
export function resolveColor(input: string): string | null {
  const key = input.trim().toLowerCase();
  const name = ALIASES[key] ?? key;
  if (PALETTE[name]) return PALETTE[name];
  const rgb = parseHex(key);
  return rgb ? toHex(rgb) : null;
}

export function colorName(hex: string): string | undefined {
  return Object.entries(PALETTE).find(([, v]) => v === hex.toLowerCase())?.[0];
}

function mix(a: RGB, b: RGB, amount: number): RGB {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  };
}

/** Truecolor swatch for terminal output. */
export function swatch(hex: string, text = "  ", textColor = textColorFor(hex)): string {
  const { r, g, b } = parseHex(hex)!;
  const fg = parseHex(textColor)!;
  return `\x1b[48;2;${r};${g};${b}m\x1b[38;2;${fg.r};${fg.g};${fg.b}m${text}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Distinct colors for many sessions (50+)

type Lab = { L: number; a: number; b: number };

/** sRGB hex to OKLab, a perceptually uniform space (distance ~ visible difference). */
function oklab(hex: string): Lab {
  const { r, g, b } = parseHex(hex)!;
  const [R, G, B] = [r, g, b].map(channel);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675778 * s,
  };
}

export function colorDistance(x: string, y: string): number {
  const p = oklab(x);
  const q = oklab(y);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return toHex({ r: f(0), g: f(8), b: f(4) });
}

/** Candidate pool: the palette first, then a hue wheel in several tones, all lifted to `level`. */
function candidates(level: ContrastLevel): string[] {
  const pool = Object.values(PALETTE);
  for (const [s, l] of [[0.85, 0.62], [0.6, 0.72], [0.9, 0.5], [0.45, 0.8], [0.7, 0.4]]) {
    for (let h = 0; h < 360; h += 10) pool.push(hslHex(h, s, l));
  }
  return [...new Set(pool.map((c) => ensureContrast(c, level)))];
}

const poolCache = new Map<ContrastLevel, string[]>();

/**
 * The color that differs most from all `taken` colors. Palette colors win
 * while they are still clearly distinct; after that generated shades fill in,
 * so 50 sessions still get 50 different colors.
 */
export function distinctColor(taken: string[], level: ContrastLevel = "AAA", seed = ""): string {
  if (!poolCache.has(level)) poolCache.set(level, candidates(level));
  const pool = poolCache.get(level)!;
  const named = new Set(Object.values(PALETTE));
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  let best = pool[0];
  let bestScore = -Infinity;
  pool.forEach((c, i) => {
    const nearest = taken.length ? Math.min(...taken.map((t) => colorDistance(c, t))) : 1;
    // Prefer named palette colors, keep gray for last, break ties stably by seed.
    const bonus = c === PALETTE.gray ? -0.2 : named.has(c) ? 0.05 : 0;
    const score = nearest + bonus + ((i + h) % pool.length) * 1e-6;
    if (score > bestScore) [best, bestScore] = [c, score];
  });
  return best;
}

// ---------------------------------------------------------------------------
// Contrast (WCAG 2.2, 1.4.3 / 1.4.6)

export type ContrastLevel = "AAA" | "AA" | "off";

export const MIN_RATIO: Record<ContrastLevel, number> = { AAA: 7, AA: 4.5, off: 1 };

const BLACK = "#000000";
const WHITE = "#ffffff";

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex)!;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colors, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `bg`. */
export function textColorFor(bg: string): string {
  return contrastRatio(bg, BLACK) >= contrastRatio(bg, WHITE) ? BLACK : WHITE;
}

export type ContrastReport = {
  color: string;
  text: string;
  ratio: number;
  aa: boolean;
  aaa: boolean;
};

export function checkContrast(bg: string, text = textColorFor(bg)): ContrastReport {
  const ratio = contrastRatio(bg, text);
  return { color: bg, text, ratio, aa: ratio >= MIN_RATIO.AA, aaa: ratio >= MIN_RATIO.AAA };
}

/**
 * The closest shade of `hex` that reaches `level` with black or white text.
 * Lightens (for black text) or darkens (for white text) in small steps and
 * keeps whichever passing shade changed the color least.
 */
export function ensureContrast(hex: string, level: ContrastLevel = "AAA"): string {
  const min = MIN_RATIO[level];
  if (Math.max(contrastRatio(hex, BLACK), contrastRatio(hex, WHITE)) >= min) return hex;
  const base = parseHex(hex)!;
  for (let step = 1; step <= 100; step++) {
    const amount = step / 100;
    const lighter = toHex(mix(base, parseHex(WHITE)!, amount));
    if (contrastRatio(lighter, BLACK) >= min) return lighter;
    const darker = toHex(mix(base, parseHex(BLACK)!, amount));
    if (contrastRatio(darker, WHITE) >= min) return darker;
  }
  return WHITE;
}

// ---------------------------------------------------------------------------
// Title dots for terminals without colorable tabs

const DOTS: [string, string][] = [
  ["🔴", "#e53935"],
  ["🟠", "#fb8c00"],
  ["🟡", "#fdd835"],
  ["🟢", "#43a047"],
  ["🔵", "#1e88e5"],
  ["🟣", "#8e24aa"],
  ["🟤", "#795548"],
  ["⚫", "#212121"],
  ["⚪", "#eeeeee"],
];

function hue(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = parseHex(hex)!;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

/** Closest colored-circle character for a hex color (used as a title prefix). */
export function dotFor(hex: string): string {
  const target = hue(hex);
  if (target.s < 0.15) return target.l > 0.5 ? "⚪" : "⚫";
  let best = DOTS[0][0];
  let bestDist = Infinity;
  for (const [dot, ref] of DOTS) {
    const c = hue(ref);
    if (c.s < 0.15) continue;
    const dh = Math.min(Math.abs(c.h - target.h), 360 - Math.abs(c.h - target.h)) / 180;
    const dist = dh * 3 + Math.abs(c.l - target.l);
    if (dist < bestDist) [best, bestDist] = [dot, dist];
  }
  return best;
}
