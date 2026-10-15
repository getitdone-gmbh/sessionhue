import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dotFor } from "./colors.js";
import { CONFIG_DIR } from "./config.js";
import { TITLES_DIR, type TerminalKind, knownColor } from "./terminal.js";

// Notifications when an agent is done or waits for you, with the answers as notification actions.
// The notifier app types the chosen answer into the iTerm2 session; closing a notification changes nothing.

export const NOTIFIER_APP = path.join(os.homedir(), "Applications", "sessionhue.app");
const NOTIFIER_BIN = path.join(NOTIFIER_APP, "Contents", "MacOS", "sessionhue");
const PENDING_DIR = path.join(CONFIG_DIR, "pending");
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export type NotifyAction = { id: string; title: string; keys?: string[]; reply?: boolean; placeholder?: string; destructive?: boolean };
export type Notice = { title: string; subtitle?: string; body: string; actions: NotifyAction[] };

// Hook payload of Claude Code (hook_event_name) or Codex (type), reduced to what we use.
export type AgentEvent = {
  hook_event_name?: string;
  type?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  permission_suggestions?: unknown[];
  last_assistant_message?: string;
  "last-assistant-message"?: string;
  stop_hook_active?: boolean;
};

const ESC = "\u001b";
const ENTER = "\r";

const TEXT = {
  en: { done: "done", waiting: "needs your approval", question: "asks", allow: "Allow", always: "Always allow", deny: "Deny", denyWith: "Deny with note…", reply: "Reply…", own: "Own answer…", openTerminal: "Answer in the terminal", agentDone: "Agent finished" },
  de: { done: "fertig", waiting: "braucht deine Freigabe", question: "fragt", allow: "Erlauben", always: "Immer erlauben", deny: "Ablehnen", denyWith: "Ablehnen mit Hinweis…", reply: "Antworten…", own: "Eigene Antwort…", openTerminal: "Im Terminal antworten", agentDone: "Agent ist durchgelaufen" },
};

export function language(): keyof typeof TEXT {
  const locale = process.env.SESSIONHUE_LANG ?? process.env.LC_ALL ?? process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return locale.toLowerCase().startsWith("de") ? "de" : "en";
}

// Plain one-liner for a notification body: no markdown, no line breaks, limited length.
export function plain(text: string, max = 180): string {
  const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function toolSummary(tool: string, input: Record<string, any> = {}): string {
  if (tool === "Bash") return input.description ? `${input.description}: ${input.command}` : String(input.command ?? "");
  if (input.file_path) return `${tool} ${path.basename(String(input.file_path))}`;
  if (input.url) return `${tool} ${input.url}`;
  if (tool.startsWith("mcp__")) return tool.split("__").slice(1).join(" · ");
  return tool;
}

// What to show for an event, or null when it needs no notification.
export function noticeFor(event: AgentEvent, label: string, lang = language()): Notice | null {
  const t = TEXT[lang];
  const name = event.hook_event_name ?? (event.type === "agent-turn-complete" ? "Stop" : undefined);

  if (name === "Stop") {
    if (event.stop_hook_active) return null;
    const last = event.last_assistant_message ?? event["last-assistant-message"] ?? "";
    return {
      title: `${label} · ${t.done}`,
      body: plain(last) || t.agentDone,
      actions: [{ id: "reply", title: t.reply, reply: true, keys: [] }],
    };
  }

  if (name === "PreToolUse" && event.tool_name === "AskUserQuestion") {
    const questions: any[] = event.tool_input?.questions ?? [];
    const q = questions[0];
    if (!q) return null;
    const options: any[] = q.options ?? [];
    const answerable = questions.length === 1 && !q.multiSelect && options.length > 0;
    return {
      title: `${label} · ${t.question}`,
      subtitle: questions.length > 1 ? `1/${questions.length} · ${q.header ?? ""}`.trim() : q.header,
      body: plain(q.question ?? ""),
      actions: answerable
        ? [
            ...options.map((o, i) => ({ id: `option${i + 1}`, title: plain(String(o.label), 40), keys: [String(i + 1)] })),
            // The first entry after the options is the free-text field.
            { id: "own", title: t.own, reply: true, keys: [String(options.length + 1)] },
          ]
        : [],
    };
  }

  if (name === "PermissionRequest" && event.tool_name && event.tool_name !== "AskUserQuestion") {
    const actions: NotifyAction[] = [{ id: "allow", title: t.allow, keys: ["1"] }];
    // Claude Code only offers "don't ask again" as option 2 when it has a suggestion for it.
    if (event.permission_suggestions?.length) actions.push({ id: "always", title: t.always, keys: ["2"] });
    actions.push({ id: "deny", title: t.deny, keys: [ESC], destructive: true }, { id: "denyWith", title: t.denyWith, keys: [ESC], reply: true });
    return { title: `${label} · ${t.waiting}`, subtitle: event.tool_name, body: plain(toolSummary(event.tool_name, event.tool_input)), actions };
  }

  return null;
}

// Events after which an open notification of this session is outdated.
export const CLEAR_EVENTS = ["UserPromptSubmit", "PostToolUse", "SessionEnd"];

export function sessionLabel(tty: string, cwd: string): string {
  const color = knownColor(tty);
  let title = "";
  try {
    title = fs.readFileSync(path.join(TITLES_DIR, path.basename(tty)), "utf8").trim();
  } catch {}
  const name = title || path.basename(cwd) || "session";
  return color && !/^\p{Extended_Pictographic}/u.test(name) ? `${dotFor(color)} ${name}` : name;
}

const notificationId = (tty: string) => `sessionhue-${path.basename(tty)}`;
const pendingFile = (tty: string) => path.join(PENDING_DIR, path.basename(tty));

export function notifierInstalled(): boolean {
  return fs.existsSync(NOTIFIER_BIN);
}

function runNotifier(args: string[]): void {
  if (!notifierInstalled()) return;
  // Detached: the hook returns at once, Claude Code never waits for the notification.
  spawn(NOTIFIER_BIN, args, { detached: true, stdio: "ignore" }).unref();
}

export function clearNotice(tty: string): void {
  if (!fs.existsSync(pendingFile(tty))) return;
  fs.rmSync(pendingFile(tty), { force: true });
  runNotifier(["clear", notificationId(tty)]);
}

export function postNotice(notice: Notice, tty: string, kind: TerminalKind): void {
  // Typing answers into the session needs iTerm2; elsewhere the notification only informs.
  const actions = kind === "iterm" ? notice.actions : [];
  const token = crypto.randomUUID();
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(pendingFile(tty), token);
  const payload = { id: notificationId(tty), tty, ...notice, actions, token, pendingFile: pendingFile(tty), skipIfFocused: true };
  runNotifier(["post", JSON.stringify(payload)]);
}

// Hook entry: reads the event, clears what is outdated and posts what needs attention.
export function handleEvent(event: AgentEvent, tty: string, kind: TerminalKind): void {
  const name = event.hook_event_name ?? "";
  if (CLEAR_EVENTS.includes(name)) return clearNotice(tty);
  const notice = noticeFor(event, sessionLabel(tty, event.cwd ?? process.cwd()));
  if (notice) postNotice(notice, tty, kind);
}

// Installs the notifier app: the prebuilt one from the package, or a fresh build when Xcode tools are there.
export function installNotifier(): string {
  const prebuilt = path.join(PACKAGE_ROOT, "native", "build", "sessionhue.app");
  fs.mkdirSync(path.dirname(NOTIFIER_APP), { recursive: true });
  fs.rmSync(NOTIFIER_APP, { recursive: true, force: true });
  if (fs.existsSync(prebuilt)) {
    fs.cpSync(prebuilt, NOTIFIER_APP, { recursive: true });
  } else {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "sessionhue-"));
    const result = spawnSync("bash", [path.join(PACKAGE_ROOT, "native", "build.sh"), out], { stdio: ["ignore", "ignore", "inherit"] });
    if (result.status !== 0) throw new Error("building the notifier failed (needs the Xcode command line tools: xcode-select --install)");
    fs.cpSync(path.join(out, "sessionhue.app"), NOTIFIER_APP, { recursive: true });
  }
  return NOTIFIER_APP;
}

