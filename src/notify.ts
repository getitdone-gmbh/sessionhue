import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, colorDistance } from "./colors.js";
import { CONFIG_DIR } from "./config.js";
import { TITLES_DIR, type TerminalKind, knownColor } from "./terminal.js";

// Notifications when an agent is done or waits for you, with the answers as notification actions.
// The notifier app types the chosen answer into the iTerm2 session; closing a notification changes nothing.

export const NOTIFIER_APP = path.join(os.homedir(), "Applications", "sessionhue.app");
const NOTIFIER_BIN = path.join(NOTIFIER_APP, "Contents", "MacOS", "sessionhue");
const PENDING_DIR = path.join(CONFIG_DIR, "pending");
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export type NotifyAction = { id: string; title: string; keys?: string[]; reply?: boolean; placeholder?: string; destructive?: boolean; close?: boolean };
export type Notice = { title: string; subtitle?: string; body: string; actions: NotifyAction[]; sendTitle?: string; titleSuffix?: string };

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
  background_tasks?: unknown[];
  session_crons?: unknown[];
};

// Words in an agent's last message that mean work is still open, even without a question.
const OPEN_WORK = /\b(todo|next steps?|still (running|open|pending|to do)|not (yet|done)|pending|waiting|later|follow[- ]up|noch nicht|noch offen|als n[äa]chstes|n[äa]chste[nr]? schritte?|l[äa]uft noch|ausstehend|offen(e|er|es|en)? punkte|warte|sp[äa]ter)\b/i;
const NOTHING_OPEN = /\b(nichts (mehr )?offen|nothing (left )?open|nothing left)\b/gi;

// The agent waits on a timer of its own (e.g. "sleep 600") and goes on by itself; dev servers, monitors and subagents do not count.
export function waitingOnTimer(event: AgentEvent): boolean {
  return (event.background_tasks ?? []).some((task: any) => task?.status !== "completed" && /(^|[;&|(]\s*|\bdo\s+)sleep\s+\d/.test(String(task?.command ?? "")));
}

// Finished for good: no question, no background agents or scheduled jobs, and nothing named as still open.
export function allDone(event: AgentEvent, message: string): boolean {
  if (event.background_tasks?.length || event.session_crons?.length) return false;
  return !OPEN_WORK.test(message.replace(NOTHING_OPEN, ""));
}

const ESC = "\u001b";
const ENTER = "\r";

const TEXT = {
  en: { send: "Send", replyTo: "Answer to", done: "done", waiting: "needs your approval", question: "asks", allow: "Allow", always: "Always allow", deny: "Deny", denyWith: "Deny with note…", reply: "Reply…", own: "Own answer…", openTerminal: "Answer in the terminal", agentDone: "Agent finished", nothingOpen: "done · nothing open", closeSession: "Close session" },
  de: { send: "Senden", replyTo: "Antwort an", done: "fertig", waiting: "braucht deine Freigabe", question: "fragt", allow: "Erlauben", always: "Immer erlauben", deny: "Ablehnen", denyWith: "Ablehnen mit Hinweis…", reply: "Antworten…", own: "Eigene Antwort…", openTerminal: "Im Terminal antworten", agentDone: "Agent ist durchgelaufen", nothingOpen: "fertig · nichts offen", closeSession: "Session schließen" },
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

// The part of a long agent message worth reading in a notification: its last question, or else its last paragraph.
export function gist(text: string, max = 240): { text: string; question: boolean } {
  const paragraphs = text.split(/\n\s*\n/).map((p) => plain(p, 10_000)).filter(Boolean);
  const tail = paragraphs.slice(-2);
  for (let i = tail.length - 1; i >= 0; i--) {
    const sentences = tail[i].split(/(?<=[.!?:])\s+/);
    for (let j = sentences.length - 1; j >= 0; j--) {
      if (!sentences[j].includes("?")) continue;
      // A short question gets the sentence before it as context.
      const withContext = sentences[j].length < 80 && j > 0 ? `${sentences[j - 1]} ${sentences[j]}` : sentences[j];
      return { text: plain(withContext, max), question: true };
    }
  }
  return { text: plain(paragraphs.at(-1) ?? "", max), question: false };
}

// What to show for an event, or null when it needs no notification.
export function noticeFor(event: AgentEvent, label: string, lang = language()): Notice | null {
  const t = TEXT[lang];
  const name = event.hook_event_name ?? (event.type === "agent-turn-complete" ? "Stop" : undefined);

  if (name === "Stop") {
    if (event.stop_hook_active || waitingOnTimer(event)) return null;
    const message = event.last_assistant_message ?? event["last-assistant-message"] ?? "";
    const last = gist(message);
    const done = !last.question && allDone(event, message);
    return {
      title: label,
      subtitle: last.question ? t.question : done ? t.nothingOpen : t.done,
      body: last.text || t.agentDone,
      actions: [
        { id: "reply", title: t.reply, reply: true, keys: [], placeholder: `${t.replyTo} ${label}` },
        // Everything finished: offer to end the agent and close its tab or window.
        ...(!done ? [] : [{ id: "close", title: t.closeSession, keys: ["/exit", ENTER], close: true }]),
      ],
      sendTitle: t.send,
    };
  }

  if (name === "PreToolUse" && event.tool_name === "AskUserQuestion") {
    const questions: any[] = event.tool_input?.questions ?? [];
    const q = questions[0];
    if (!q) return null;
    const options: any[] = q.options ?? [];
    const answerable = questions.length === 1 && !q.multiSelect && options.length > 0;
    return {
      title: label,
      subtitle: [t.question, q.header, questions.length > 1 ? `1/${questions.length}` : ""].filter(Boolean).join(" · "),
      sendTitle: t.send,
      body: plain(q.question ?? ""),
      actions: answerable
        ? [
            ...options.map((o, i) => ({ id: `option${i + 1}`, title: plain(String(o.label), 40), keys: [String(i + 1)] })),
            // The first entry after the options is the free-text field.
            { id: "own", title: t.own, reply: true, keys: [String(options.length + 1)], placeholder: plain(q.question ?? "", 60) },
          ]
        : [],
    };
  }

  if (name === "PermissionRequest" && event.tool_name && event.tool_name !== "AskUserQuestion") {
    const actions: NotifyAction[] = [{ id: "allow", title: t.allow, keys: ["1"] }];
    // Claude Code only offers "don't ask again" as option 2 when it has a suggestion for it.
    if (event.permission_suggestions?.length) actions.push({ id: "always", title: t.always, keys: ["2"] });
    actions.push({ id: "deny", title: t.deny, keys: [ESC], destructive: true }, { id: "denyWith", title: t.denyWith, keys: [ESC], reply: true, placeholder: t.denyWith.replace("…", "") });
    return { title: label, subtitle: `${t.waiting} · ${event.tool_name}`, body: plain(toolSummary(event.tool_name, event.tool_input), 240), actions, sendTitle: t.send };
  }

  return null;
}

const COLOR_WORDS = {
  en: { red: "red", orange: "orange", amber: "yellow", green: "green", teal: "teal", cyan: "cyan", blue: "blue", indigo: "lavender", purple: "purple", pink: "pink", brown: "beige", gray: "gray" },
  de: { red: "rot", orange: "orange", amber: "gelb", green: "grün", teal: "türkis", cyan: "cyan", blue: "blau", indigo: "lavendel", purple: "lila", pink: "rosa", brown: "beige", gray: "grau" },
} as const;

// The session color as a word, so the notification points to the window with that title bar color.
export function colorWord(hex: string, lang = language()): string {
  let best: keyof typeof PALETTE = "gray";
  for (const name of Object.keys(PALETTE)) if (colorDistance(hex, PALETTE[name]) < colorDistance(hex, PALETTE[best])) best = name;
  return (COLOR_WORDS[lang] as Record<string, string>)[best] ?? best;
}

// Events after which an open notification of this session is outdated.
export const CLEAR_EVENTS = ["UserPromptSubmit", "PostToolUse", "SessionEnd"];

// Plain session name, without the emoji dot Terminal.app titles carry.
export function sessionLabel(tty: string, cwd: string): string {
  let title = "";
  try {
    title = fs.readFileSync(path.join(TITLES_DIR, path.basename(tty)), "utf8").trim();
  } catch {}
  // Terminal.app titles carry a colored dot in front, which is not part of the name.
  title = title.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");
  return title || path.basename(cwd) || "session";
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

// What an open notification waits for: posted at `at` (ms), for one tool call or (empty) the whole turn.
export type Pending = { token: string; at: number; tool: string };

// The tool a notification waits for, so a different tool finishing in parallel leaves it alone.
// By name only: the input can differ after the call (e.g. answers added), and a notification left open too long could type into a session that moved on.
export function toolKey(event: AgentEvent): string {
  return event.tool_name ?? "";
}

function readPending(tty: string): Pending | null {
  try {
    const [token, at, tool] = fs.readFileSync(pendingFile(tty), "utf8").split("\n");
    return { token, at: Number(at) || 0, tool: tool ?? "" };
  } catch {
    return null;
  }
}

// Hooks for clearing run in the background, so one can arrive after a newer notification was posted.
export function outdatedBy(pending: Pending, event: AgentEvent, happenedAt: number): boolean {
  if (pending.at > happenedAt) return false;
  if (event.hook_event_name === "PostToolUse" && pending.tool && pending.tool !== toolKey(event)) return false;
  return true;
}

export function clearNotice(tty: string, event: AgentEvent, happenedAt: number): void {
  const pending = readPending(tty);
  if (!pending || !outdatedBy(pending, event, happenedAt)) return;
  fs.rmSync(pendingFile(tty), { force: true });
  runNotifier(["clear", notificationId(tty)]);
}

export function postNotice(notice: Notice, tty: string, kind: TerminalKind, tool = ""): void {
  // Typing answers into the session needs iTerm2; elsewhere the notification only informs.
  const actions = kind === "iterm" ? notice.actions : [];
  const token = crypto.randomUUID();
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  // First line is the token the notifier checks; then post time and the awaited tool call.
  fs.writeFileSync(pendingFile(tty), `${token}\n${Date.now()}\n${tool}`);
  const color = knownColor(tty);
  // The notifier swaps the title for the iTerm2 session name (the topic Claude Code gives it) and keeps this suffix.
  const titleSuffix = color && kind === "iterm" ? ` · ${colorWord(color)}` : undefined;
  const payload = { id: notificationId(tty), tty, ...notice, title: notice.title + (titleSuffix ?? ""), titleSuffix, actions, token, pendingFile: pendingFile(tty), skipIfFocused: true };
  runNotifier(["post", JSON.stringify(payload)]);
}

const LOG_FILE = path.join(os.homedir(), "Library", "Logs", "sessionhue.log");

function log(message: string): void {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString().slice(0, 19)}Z ${message}\n`);
  } catch {}
}

// Hook entry: reads the event, clears what is outdated and posts what needs attention.
export function handleEvent(event: AgentEvent, tty: string, kind: TerminalKind): void {
  const name = event.hook_event_name ?? "";
  // Process start is when the hook fired, even if it ran late in the background.
  if (CLEAR_EVENTS.includes(name)) return clearNotice(tty, event, Math.floor(performance.timeOrigin));
  const notice = noticeFor(event, sessionLabel(tty, event.cwd ?? process.cwd()));
  if (!notice && name === "Stop") log(`skip Stop for ${tty}: ${event.stop_hook_active ? "stop hook active" : "agent waits on its own timer"}`);
  if (notice) postNotice(notice, tty, kind, name === "Stop" ? "" : toolKey(event));
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

