import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { distinctColor } from "./colors.js";
import { CONFIG_DIR, type Config, findPreset, projectRoot } from "./config.js";

export type Usage = { root: string; sessions: number; lastUsed: number; lastColor?: string; lastTitle?: string };

const HISTORY_FILE = path.join(CONFIG_DIR, "history.json");

type HistoryEntry = { color: string; title?: string; at: number; count: number };

function loadHistory(): Record<string, HistoryEntry> {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Remembers which look a project got, so it can be suggested next time. */
export function recordUse(dir: string, color: string, title?: string): void {
  const root = projectRoot(dir);
  const history = loadHistory();
  const prev = history[root];
  history[root] = { color, title, at: Date.now(), count: (prev?.count ?? 0) + 1 };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + "\n");
}

/** Working directories of past Claude Code sessions (~/.claude/projects/<slug>/<id>.jsonl). */
function claudeSessions(): { cwd: string; at: number }[] {
  const base = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
  const out: { cwd: string; at: number }[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(base, d)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(base, d, f);
      try {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(64 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString("utf8", 0, n));
        if (m) out.push({ cwd: JSON.parse(`"${m[1]}"`), at: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
  return out;
}

/** Projects you have worked in, most used first, merged from Claude Code and sessionhue history. */
export function usage(): Usage[] {
  const byRoot = new Map<string, Usage>();
  const bump = (dir: string, at: number, n = 1) => {
    if (!fs.existsSync(dir)) return;
    const root = projectRoot(dir);
    if (root === os.homedir()) return;
    const u = byRoot.get(root) ?? { root, sessions: 0, lastUsed: 0 };
    u.sessions += n;
    u.lastUsed = Math.max(u.lastUsed, at);
    byRoot.set(root, u);
  };
  for (const s of claudeSessions()) bump(s.cwd, s.at);
  for (const [root, h] of Object.entries(loadHistory())) {
    bump(root, h.at, h.count);
    const u = byRoot.get(projectRoot(root));
    if (u) Object.assign(u, { lastColor: h.color, lastTitle: h.title });
  }
  return [...byRoot.values()].sort((a, b) => b.sessions - a.sessions || b.lastUsed - a.lastUsed);
}

export type Suggestion = { root: string; name: string; color: string; title: string; sessions: number };

/** Presets worth creating: frequently used projects that have none yet, each with a distinct color. */
export function suggestions(config: Config, limit = 50): Suggestion[] {
  const taken = config.presets.map((p) => p.color);
  const result: Suggestion[] = [];
  for (const u of usage()) {
    if (findPreset(config, u.root)) continue;
    const name = path.basename(u.root);
    const color = u.lastColor ?? distinctColor(taken, config.contrast, u.root);
    taken.push(color);
    result.push({ root: u.root, name, color, title: u.lastTitle ?? name, sessions: u.sessions });
    if (result.length >= limit) break;
  }
  return result;
}

/** Suggested look for a single directory without a preset. */
export function suggestFor(config: Config, dir: string): Suggestion {
  const root = projectRoot(dir);
  const found = suggestions(config, 1000).find((s) => s.root === root);
  if (found) return found;
  const name = path.basename(root);
  return { root, name, color: distinctColor(config.presets.map((p) => p.color), config.contrast, root), title: name, sessions: 0 };
}
