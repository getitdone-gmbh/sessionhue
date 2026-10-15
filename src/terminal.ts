import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type ContrastLevel, distinctColor, dotFor, parseHex, textColorFor } from "./colors.js";
import { CONFIG_DIR } from "./config.js";

/**
 * How the color is shown. Never as a background behind console output:
 * - iterm:   colored tab (iTerm2 picks the label color)
 * - kitty:   colored tab with explicit black/white label (needs allow_remote_control)
 * - wezterm: user vars, colored by a format-tab-title snippet (see README)
 * - others:  colored dot in front of the tab title
 */
export type TerminalKind = "apple" | "iterm" | "kitty" | "wezterm" | "ghostty" | "generic";

export type Look = { color: string; title?: string };

/**
 * The tty of the session we should color. Works from an interactive shell and
 * from tty-less children (Claude Code hooks, editors) by walking up the process tree.
 */
export function findTty(): string | null {
  if (process.env.SESSIONHUE_TTY) return process.env.SESSIONHUE_TTY;
  let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    try {
      const out = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], { encoding: "utf8" }).trim();
      const [ppid, tty] = out.split(/\s+/);
      if (tty && tty !== "??" && tty !== "-") return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
      pid = Number(ppid);
    } catch {
      return null;
    }
  }
  return null;
}

export function detectTerminal(): TerminalKind {
  const p = process.env.TERM_PROGRAM ?? "";
  if (p === "Apple_Terminal") return "apple";
  if (p === "iTerm.app" || process.env.ITERM_SESSION_ID) return "iterm";
  if (process.env.KITTY_WINDOW_ID) return "kitty";
  if (p === "WezTerm" || process.env.WEZTERM_PANE) return "wezterm";
  if (p === "ghostty" || process.env.GHOSTTY_RESOURCES_DIR) return "ghostty";
  return "generic";
}

/** Text shown in the tab: the title, prefixed with a colored dot where tabs can't be colored. */
export function tabLabel(look: Look, kind: TerminalKind): string {
  const title = (look.title ?? "").replace(/[\x00-\x1f"\\]/g, "");
  const colorableTab = kind === "iterm" || kind === "kitty" || kind === "wezterm";
  return colorableTab ? title : `${dotFor(look.color)} ${title}`.trim();
}

function osascript(script: string): string {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

function appleTab(tty: string, body: string): void {
  osascript(`tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        ${body}
      end if
    end repeat
  end repeat
end tell`);
}

/**
 * Last label per tty. The shell hook re-sends it after every prompt, because
 * shells (oh-my-zsh, starship, ...) reset the title on each prompt.
 */
export const TITLES_DIR = path.join(CONFIG_DIR, "titles");

function rememberTitle(tty: string, label: string | null): void {
  const file = path.join(TITLES_DIR, path.basename(tty));
  if (label) {
    fs.mkdirSync(TITLES_DIR, { recursive: true });
    fs.writeFileSync(file, label);
  } else {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Color per tty. A session keeps its color while it is open, and sessions
 * without a preset get one that no other open session uses.
 */
const COLORS_DIR = path.join(CONFIG_DIR, "sessions");

export function rememberColor(tty: string, color: string | null): void {
  const file = path.join(COLORS_DIR, path.basename(tty));
  if (color) {
    fs.mkdirSync(COLORS_DIR, { recursive: true });
    fs.writeFileSync(file, color);
  } else {
    fs.rmSync(file, { force: true });
  }
}

/** ttys that still have a process attached, e.g. "ttys004". */
function openTtys(): Set<string> {
  try {
    return new Set(execFileSync("ps", ["-A", "-o", "tty="], { encoding: "utf8" }).split(/\s+/).filter((t) => t && t !== "??"));
  } catch {
    return new Set();
  }
}

/** This session's color, or a new one far from every open session and from `avoid`. */
export function sessionColor(tty: string, avoid: string[], level: ContrastLevel): string {
  const own = path.basename(tty);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(COLORS_DIR);
  } catch {}
  const open = openTtys();
  const taken = [...avoid];
  for (const name of entries) {
    const file = path.join(COLORS_DIR, name);
    if (name === own) return fs.readFileSync(file, "utf8").trim();
    if (!open.has(name)) fs.rmSync(file, { force: true });
    else taken.push(fs.readFileSync(file, "utf8").trim());
  }
  const color = distinctColor(taken, level);
  rememberColor(tty, color);
  return color;
}

const osc = (s: string) => `\x1b]${s}\x07`;
const b64 = (s: string) => Buffer.from(s).toString("base64");

export function applyLook(look: Look, tty: string, kind = detectTerminal()): void {
  const label = tabLabel(look, kind);
  rememberTitle(tty, label || null);

  if (kind === "apple") {
    // Terminal.app can't color tabs; the dot lives in the tab title only.
    return appleTab(tty, `set custom title of t to "${label}"\n        set title displays custom title of t to true`);
  }

  let seq = "";
  if (kind === "iterm") {
    const { r, g, b } = parseHex(look.color)!;
    seq += osc(`6;1;bg;red;brightness;${r}`) + osc(`6;1;bg;green;brightness;${g}`) + osc(`6;1;bg;blue;brightness;${b}`);
  }
  if (kind === "kitty") {
    const fg = textColorFor(look.color);
    try {
      execFileSync("kitty", ["@", "set-tab-color", "--self", `active_bg=${look.color}`, `active_fg=${fg}`, `inactive_bg=${look.color}`, `inactive_fg=${fg}`], { stdio: "pipe" });
    } catch {
      // Remote control disabled: fall back to a title dot.
      return applyLook(look, tty, "generic");
    }
  }
  if (kind === "wezterm") {
    seq += osc(`1337;SetUserVar=sessionhue_bg=${b64(look.color)}`) + osc(`1337;SetUserVar=sessionhue_fg=${b64(textColorFor(look.color))}`);
  }
  if (label) seq += osc(`1;${label}`) + osc(`2;${label}`);
  fs.writeFileSync(tty, seq);
}

export function resetLook(tty: string, kind = detectTerminal()): void {
  rememberTitle(tty, null);
  rememberColor(tty, null);
  if (kind === "apple") return appleTab(tty, "set title displays custom title of t to false");
  let seq = osc("1;") + osc("2;");
  if (kind === "iterm") seq += osc("6;1;bg;*;default");
  if (kind === "wezterm") seq += osc("1337;SetUserVar=sessionhue_bg=") + osc("1337;SetUserVar=sessionhue_fg=");
  if (kind === "kitty") {
    try {
      execFileSync("kitty", ["@", "set-tab-color", "--self", "active_bg=NONE", "active_fg=NONE", "inactive_bg=NONE", "inactive_fg=NONE"], { stdio: "pipe" });
    } catch {}
  }
  fs.writeFileSync(tty, seq);
}
