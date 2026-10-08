#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { MIN_RATIO, PALETTE, checkContrast, colorName, ensureContrast, resolveColor, swatch } from "./colors.js";
import { type Config, type Preset, configPath, findPreset, loadConfig, projectRoot, saveConfig, upsertPreset } from "./config.js";
import { suggestFor, suggestions, recordUse } from "./history.js";
import { brewAvailable, installIterm, installLauncher, installProfile, installShellHook, isMac, itermInstalled, itermRunning, quitIterm, removeLauncher, setMinimalTheme } from "./setup.js";
import { type Look, TITLES_DIR, applyLook, detectTerminal, findTty, resetLook } from "./terminal.js";

const HELP = `sessionhue · terminal session colors

Usage
  sessionhue setup                   guided first-run setup (run this after installing)
  sessionhue                         pick a color interactively (with suggestions)
  sessionhue set <color> [title]     color this tab, e.g. "set blue api" or "set #ff8800"
  sessionhue apply                   apply the preset for the current folder
  sessionhue reset                   back to the default look
  sessionhue suggest [--save] [-n N] presets for repos you worked in (incl. Claude Code history)
  sessionhue preset list
  sessionhue preset add <name> --color <c> [--title <t>] [--match <path>]...
  sessionhue preset rm <name>
  sessionhue colors                  show the palette with contrast ratings
  sessionhue check <color>           WCAG contrast check (label on indicator)
  sessionhue init <zsh|bash>         shell hook: auto-apply presets on cd
  sessionhue profile iterm [--default]  optional: readable light iTerm2 profile (AAA text colors)
  sessionhue launcher [remove]       Spotlight "Terminal iTerm" launcher (macOS)
  sessionhue claude [--write]        Claude Code hook: auto-apply on session start
  sessionhue config                  show config file path

Options
  --save       also save as preset for the current repo (set)
  --quiet      no output, never fails (apply, for hooks)
  --tty <dev>  target a specific tty instead of the current session

Colors: ${Object.keys(PALETTE).join(", ")} or any #hex.`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    color: { type: "string", short: "c" },
    title: { type: "string", short: "t" },
    match: { type: "string", short: "m", multiple: true },
    save: { type: "boolean", short: "s" },
    quiet: { type: "boolean", short: "q" },
    write: { type: "boolean" },
    default: { type: "boolean" },
    tty: { type: "string" },
    limit: { type: "string", short: "n" },
    text: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const cwd = process.cwd();
const [cmd, ...rest] = positionals;

function fail(msg: string): never {
  if (opts.quiet) process.exit(0);
  console.error(`sessionhue: ${msg}`);
  process.exit(1);
}

function tty(): string {
  const t = opts.tty ?? findTty();
  if (!t) fail("could not find the terminal of this session");
  return t;
}

/** Resolves a color and lifts it to the configured contrast level, telling the user if it changed. */
function accessibleColor(input: string, config: Config): string {
  const color = resolveColor(input) ?? fail(`unknown color "${input}"`);
  const fixed = ensureContrast(color, config.contrast);
  if (fixed !== color && !opts.quiet) {
    const before = checkContrast(color).ratio.toFixed(2);
    const after = checkContrast(fixed).ratio.toFixed(2);
    console.error(`${color} only reaches ${before}:1, using ${fixed} (${after}:1, ${config.contrast})`);
  }
  return fixed;
}

function paint(look: Look, config: Config): void {
  // Presets saved before a stricter contrast setting are lifted on the fly.
  const color = ensureContrast(look.color, config.contrast);
  applyLook({ ...look, color }, tty());
  recordUse(cwd, color, look.title);
}

function describe(look: Look): string {
  return `${swatch(look.color)} ${colorName(look.color) ?? look.color}${look.title ? ` · ${look.title}` : ""}`;
}

function cmdSet(config: Config): void {
  const [colorArg, ...titleParts] = rest;
  if (!colorArg) fail('missing color, e.g. "sessionhue set blue api"');
  const color = accessibleColor(colorArg, config);
  const title = opts.title ?? (titleParts.join(" ") || undefined);
  paint({ color, title }, config);
  if (opts.save) {
    const root = projectRoot(cwd);
    const name = path.basename(root);
    upsertPreset(config, { name, color, title, match: [root] });
    saveConfig(config);
    console.log(`saved preset "${name}" for ${root}`);
  }
}

function cmdApply(config: Config): void {
  const preset = findPreset(config, cwd);
  if (preset) return paint(preset, config);
  if (config.autoColorUnknownRepos) {
    const s = suggestFor(config, cwd);
    return applyLook({ color: ensureContrast(s.color, config.contrast), title: s.title }, tty());
  }
  if (!opts.quiet) console.log("no preset for this folder (try: sessionhue suggest)");
}

function cmdPreset(config: Config): void {
  const [sub, name] = rest;
  if (!sub || sub === "list" || sub === "ls") {
    if (!config.presets.length) return console.log("no presets yet (try: sessionhue suggest)");
    for (const pr of config.presets) console.log(`${describe(pr)}  [${pr.name}]  ${pr.match.join(", ")}`);
    return;
  }
  if (sub === "add") {
    if (!name) fail("preset add needs a name");
    if (!opts.color) fail("preset add needs --color");
    const color = accessibleColor(opts.color, config);
    const preset: Preset = { name, color, title: opts.title ?? name, match: opts.match ?? [projectRoot(cwd)] };
    upsertPreset(config, preset);
    saveConfig(config);
    return console.log(`saved ${describe(preset)} for ${preset.match.join(", ")}`);
  }
  if (sub === "rm" || sub === "remove") {
    const before = config.presets.length;
    config.presets = config.presets.filter((pr) => pr.name !== name);
    if (config.presets.length === before) fail(`no preset "${name}"`);
    saveConfig(config);
    return console.log(`removed "${name}"`);
  }
  fail(`unknown preset command "${sub}"`);
}

async function cmdSuggest(config: Config): Promise<void> {
  const list = suggestions(config, Number(opts.limit ?? 50));
  if (!list.length) return console.log("nothing to suggest, every project you used has a preset");
  if (!opts.save) {
    for (const s of list) console.log(`${describe(s)}  ${s.root}  (${s.sessions} ${s.sessions === 1 ? "session" : "sessions"})`);
    return console.log("\nsave them with: sessionhue suggest --save");
  }
  const picked = await p.multiselect({
    message: "Create presets for these projects?",
    options: list.map((s) => ({ value: s, label: `${swatch(s.color)} ${s.name}`, hint: `${s.sessions} sessions · ${s.root}` })),
    initialValues: list,
  });
  if (p.isCancel(picked)) return;
  for (const s of picked) upsertPreset(config, { name: s.name, color: s.color, title: s.title, match: [s.root] });
  saveConfig(config);
  p.outro(`saved ${picked.length} presets`);
}

async function pickColor(config: Config, initial?: string): Promise<string | symbol> {
  const choice = await p.select({
    message: "Color",
    initialValue: initial && colorName(initial) ? initial : PALETTE.blue,
    options: [
      ...Object.entries(PALETTE).map(([name, hex]) => ({ value: hex, label: `${swatch(hex)} ${name}` })),
      { value: "custom", label: "custom #hex" },
    ],
  });
  if (p.isCancel(choice) || choice !== "custom") return choice;
  const hex = await p.text({ message: "Hex color", placeholder: "#ff8800", validate: (v) => (resolveColor(v ?? "") ? undefined : "not a color") });
  return p.isCancel(hex) ? hex : accessibleColor(hex, config);
}

async function cmdPick(config: Config): Promise<void> {
  p.intro("sessionhue");
  const root = projectRoot(cwd);
  const current = findPreset(config, cwd);
  const suggestion = current ? undefined : suggestFor(config, cwd);

  type Choice = { kind: "preset" | "suggest" | "custom" | "reset"; preset?: Preset };
  const options: { value: Choice; label: string; hint?: string }[] = [];
  if (current) options.push({ value: { kind: "preset", preset: current }, label: describe(current), hint: "preset for this folder" });
  if (suggestion) options.push({ value: { kind: "suggest" }, label: describe(suggestion), hint: "suggested for this repo" });
  for (const pr of config.presets) if (pr !== current) options.push({ value: { kind: "preset", preset: pr }, label: describe(pr), hint: pr.name });
  options.push({ value: { kind: "custom" }, label: "Custom color and title…" }, { value: { kind: "reset" }, label: "Reset" });

  const choice = await p.select({ message: "Color this session", options });
  if (p.isCancel(choice)) return p.cancel("cancelled");

  if (choice.kind === "reset") {
    resetLook(tty());
    return p.outro("reset");
  }
  if (choice.kind === "preset") {
    paint(choice.preset!, config);
    return p.outro(describe(choice.preset!));
  }

  let look: Look;
  if (choice.kind === "suggest") {
    look = { color: suggestion!.color, title: suggestion!.title };
  } else {
    const color = await pickColor(config, suggestion?.color);
    if (p.isCancel(color)) return p.cancel("cancelled");
    const title = await p.text({ message: "Title (optional)", initialValue: path.basename(root) });
    if (p.isCancel(title)) return p.cancel("cancelled");
    look = { color: color as string, title: title || undefined };
  }
  paint(look, config);

  const save = await p.confirm({ message: `Use this every time for ${path.basename(root)}?` });
  if (!p.isCancel(save) && save) {
    upsertPreset(config, { name: path.basename(root), color: look.color, title: look.title, match: [root] });
    saveConfig(config);
  }
  p.outro(describe(look));
}

function cmdInit(): void {
  const shell = rest[0] ?? path.basename(process.env.SHELL ?? "zsh");
  const titles = TITLES_DIR.replace(os.homedir(), "$HOME");
  // On cd: apply the repo preset. On every prompt: re-send our title, since
  // shells and frameworks (oh-my-zsh, starship) overwrite it.
  const fns = `_sessionhue_cd() {
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  [ "$root" = "$_SESSIONHUE_ROOT" ] && return
  _SESSIONHUE_ROOT=$root
  (sessionhue apply --quiet >/dev/null 2>&1 &)
}
_sessionhue_title() {
  local f="${titles}/\${_SESSIONHUE_TTY##*/}"
  [ -r "$f" ] || return
  local t
  t=$(<"$f")
  printf '\\033]1;%s\\007\\033]2;%s\\007' "$t" "$t"
}`;
  if (shell === "zsh") {
    console.log(`_SESSIONHUE_TTY=$TTY\n${fns}\nautoload -Uz add-zsh-hook\nadd-zsh-hook chpwd _sessionhue_cd\nadd-zsh-hook precmd _sessionhue_title\n_sessionhue_cd`);
  } else if (shell === "bash") {
    console.log(`_SESSIONHUE_TTY=$(tty)\n${fns}\nPROMPT_COMMAND="_sessionhue_cd;_sessionhue_title\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`);
  } else {
    fail(`unsupported shell "${shell}" (zsh, bash)`);
  }
}

function cmdClaude(): void {
  // SessionStart colors the tab; Stop re-applies it after Claude Code renamed the tab for a new topic.
  const hook = { matcher: "", hooks: [{ type: "command", command: "sessionhue apply --quiet" }] };
  const events = ["SessionStart", "Stop"];
  const file = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "settings.json");
  if (!opts.write) {
    console.log(`Add this to ${file} (or run: sessionhue claude --write):\n`);
    console.log(JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [hook]])) }, null, 2));
    return;
  }
  let settings: Record<string, any> = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fail(`${file} is not valid JSON, not touching it`);
    }
  }
  settings.hooks ??= {};
  const added = events.filter((e) => {
    settings.hooks[e] ??= [];
    if (JSON.stringify(settings.hooks[e]).includes("sessionhue apply")) return false;
    settings.hooks[e].push(hook);
    return true;
  });
  if (!added.length) return console.log("Claude Code hooks already installed");
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`installed ${added.join(" + ")} hooks in ${file}`);
}

function rating(ratio: number): string {
  return ratio >= MIN_RATIO.AAA ? "AAA" : ratio >= MIN_RATIO.AA ? "AA " : "fail";
}

/** Optional extra: installs a light iTerm2 profile whose text colors all reach AAA. Never touches shell or prompt. */
function cmdProfile(): void {
  if (rest[0] !== "iterm") fail("usage: sessionhue profile iterm [--default]");
  if (opts.default && itermRunning()) fail("quit iTerm2 first (it overwrites its settings on quit), then run this again from Terminal.app");
  const dir = installProfile(Boolean(opts.default));
  console.log(`installed iTerm2 profile "sessionhue Light AAA" (${dir})`);
  console.log(opts.default ? "set as default profile for new iTerm2 windows" : "pick it in iTerm2 > Settings > Profiles, or rerun with --default");
}

function cmdLauncher(): void {
  if (rest[0] === "remove") {
    removeLauncher();
    return console.log("removed the Terminal iTerm launcher");
  }
  if (!itermInstalled()) fail("iTerm2 is not installed");
  console.log(`installed ${installLauncher()}: type "terminal" in Spotlight and pick "Terminal iTerm"`);
}

/** Guided first-run: every step is optional and asked for. */
async function cmdSetup(config: Config): Promise<void> {
  p.intro("sessionhue setup");
  const yes = async (message: string, initialValue = true) => {
    const answer = await p.confirm({ message, initialValue });
    if (p.isCancel(answer)) {
      p.cancel("setup cancelled, nothing else changed");
      process.exit(0);
    }
    return answer;
  };

  if (isMac()) {
    p.note(
      "Terminal.app cannot color its title bar, it only gets a colored dot.\nThe colored title bar needs iTerm2 (free). Your shell, prompt and plugins stay the same.",
      "Terminal",
    );
    if (!itermInstalled()) {
      if (brewAvailable() && (await yes("Install iTerm2 with Homebrew?"))) installIterm();
      else if (!itermInstalled()) p.log.info("Get iTerm2 from https://iterm2.com and run `sessionhue setup` again for the iTerm2 steps.");
    }
    if (itermInstalled()) {
      const theme = await yes("Use the iTerm2 Minimal theme, so the color fills the whole title bar?");
      const profile = await yes("Install the readable light profile (all text colors AAA) and make it the default?", false);
      if ((theme || profile) && itermRunning()) {
        // Quitting iTerm2 from inside iTerm2 would end this very setup.
        if (detectTerminal() === "iterm") p.log.warn("iTerm2 overwrites these settings when it quits. Quit iTerm2, then run `sessionhue setup` again from Terminal.app.");
        else if (await yes("iTerm2 is running and would undo these settings when it quits. Quit iTerm2 now?")) quitIterm();
        else p.log.warn("Skipped: quit iTerm2 and run `sessionhue setup` again to apply them.");
      }
      if (!itermRunning()) {
        if (theme) setMinimalTheme();
        if (profile) installProfile(true);
        if (theme || profile) p.log.success("iTerm2 settings applied");
      }
      if (await yes('Add a "Terminal iTerm" launcher, so cmd+space "terminal" opens iTerm2?')) {
        installLauncher();
        p.log.success('Spotlight: type "terminal" and pick "Terminal iTerm" once, then it stays on top');
      }
    }
  }

  const shell = path.basename(process.env.SHELL ?? "zsh") === "bash" ? "bash" : "zsh";
  if (await yes(`Color tabs automatically when you cd into a repo (adds one line to ~/.${shell}rc)?`)) {
    p.log.success(`added the hook to ${installShellHook(shell)}`);
  }
  if (await yes("Color Claude Code sessions automatically (adds hooks to ~/.claude/settings.json)?", false)) {
    opts.write = true;
    cmdClaude();
  }
  const list = suggestions(config);
  if (list.length && (await yes(`Create presets for ${list.length} repos you worked in?`))) {
    opts.save = true;
    await cmdSuggest(config);
  }
  p.outro("done. Open a new terminal window and run `sessionhue` to color it.");
}

function cmdColors(): void {
  for (const [name, hex] of Object.entries(PALETTE)) {
    const c = checkContrast(hex);
    console.log(`${swatch(hex, " Aa ")} ${name.padEnd(8)} ${hex}  ${c.ratio.toFixed(2)}:1 ${rating(c.ratio)}`);
  }
}

/** Contrast checker: label (black or white, or --text) on the indicator color. */
function cmdCheck(config: Config): void {
  const input = rest[0] ?? fail('missing color, e.g. "sessionhue check #0090ff"');
  const color = resolveColor(input) ?? fail(`unknown color "${input}"`);
  const text = opts.text ? (resolveColor(opts.text) ?? fail(`unknown color "${opts.text}"`)) : undefined;
  const c = checkContrast(color, text);
  console.log(`${swatch(color, " Aa ", c.text)} ${color} with ${c.text} text: ${c.ratio.toFixed(2)}:1`);
  console.log(`  AA  (4.5:1) ${c.aa ? "pass" : "fail"}`);
  console.log(`  AAA (7:1)   ${c.aaa ? "pass" : "fail"}`);
  const fixed = ensureContrast(color, config.contrast);
  if (!text && fixed !== color) {
    console.log(`  closest ${config.contrast} shade: ${swatch(fixed, " Aa ")} ${fixed} (${checkContrast(fixed).ratio.toFixed(2)}:1)`);
  }
  if (!(config.contrast === "AAA" ? c.aaa : config.contrast === "AA" ? c.aa : true)) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (opts.help || cmd === "help") return console.log(HELP);
  const config = loadConfig();
  switch (cmd) {
    case undefined:
    case "pick":
      return cmdPick(config);
    case "set":
      return cmdSet(config);
    case "apply":
      return cmdApply(config);
    case "reset":
      return resetLook(tty());
    case "preset":
    case "presets":
      return cmdPreset(config);
    case "suggest":
      return cmdSuggest(config);
    case "colors":
      return cmdColors();
    case "profile":
      return cmdProfile();
    case "setup":
      return cmdSetup(config);
    case "launcher":
      return cmdLauncher();
    case "check":
      return cmdCheck(config);
    case "init":
      return cmdInit();
    case "claude":
      return cmdClaude();
    case "config":
      return console.log(configPath());
    case "which":
      return console.log(`${detectTerminal()} ${tty()}`);
    default: {
      // Shortcut: "sessionhue blue api" == "sessionhue set blue api"
      if (resolveColor(cmd)) {
        rest.unshift(cmd);
        return cmdSet(config);
      }
      fail(`unknown command "${cmd}" (see sessionhue --help)`);
    }
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
