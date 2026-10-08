import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContrastLevel } from "./colors.js";

export type Preset = {
  name: string;
  color: string;
  title?: string;
  /** Absolute paths (repo roots or folders). A session inside one of them gets this preset. */
  match: string[];
};

export type Config = {
  presets: Preset[];
  /** Minimum contrast between the indicator color and the label on top of it. */
  contrast: ContrastLevel;
  /** Color repos without a preset with a stable suggested color on `apply`. */
  autoColorUnknownRepos: boolean;
};

const DEFAULTS: Config = {
  presets: [],
  contrast: "AAA",
  autoColorUnknownRepos: false,
};

export const CONFIG_DIR = process.env.SESSIONHUE_HOME ?? path.join(os.homedir(), ".config", "sessionhue");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return { ...DEFAULTS, ...raw, presets: raw.presets ?? [] };
  } catch {
    return { ...DEFAULTS, presets: [] };
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function configPath(): string {
  return CONFIG_FILE;
}

/** Walks up from `dir` to the nearest git root, or returns `dir` itself. */
export function projectRoot(dir: string): string {
  let cur = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(dir);
    cur = parent;
  }
}

/** Most specific preset whose match path contains `dir`. */
export function findPreset(config: Config, dir: string): Preset | undefined {
  const abs = path.resolve(dir);
  let best: { preset: Preset; len: number } | undefined;
  for (const preset of config.presets) {
    for (const m of preset.match) {
      const target = path.resolve(m.replace(/^~(?=$|\/)/, os.homedir()));
      if (abs === target || abs.startsWith(target + path.sep)) {
        if (!best || target.length > best.len) best = { preset, len: target.length };
      }
    }
  }
  return best?.preset;
}

export function upsertPreset(config: Config, preset: Preset): void {
  const i = config.presets.findIndex((p) => p.name === preset.name);
  if (i >= 0) config.presets[i] = preset;
  else config.presets.push(preset);
}
