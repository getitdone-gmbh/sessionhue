import assert from "node:assert/strict";
import test from "node:test";
import { allDone, colorWord, waitingOnTimer, gist, noticeFor, outdatedBy, plain, toolKey } from "./notify.js";

test("Stop: done notice with the last message and a reply field", () => {
  const n = noticeFor({ hook_event_name: "Stop", last_assistant_message: "All **tests** pass.\n\nShip it?" }, "api", "en")!;
  assert.equal(n.title, "api");
  assert.equal(n.subtitle, "asks");
  assert.equal(n.body, "Ship it?");
  assert.equal(noticeFor({ hook_event_name: "Stop", last_assistant_message: "Done." }, "api", "en")!.subtitle, "done · nothing open");
  const open = noticeFor({ hook_event_name: "Stop", last_assistant_message: "Part A is merged. Part B is not done yet." }, "api", "en")!;
  assert.equal(open.subtitle, "done");
  assert.deepEqual(open.actions.map((a) => a.id), ["reply"]);
  assert.deepEqual(n.actions.map((a) => a.id), ["reply"]);
  const finished = noticeFor({ hook_event_name: "Stop", last_assistant_message: "All done, PR is merged." }, "api", "de")!;
  assert.equal(finished.subtitle, "fertig · nichts offen");
  assert.deepEqual(finished.actions.map((a) => [a.id, a.keys, a.close]), [["reply", [], undefined], ["close", ["/exit", "\r"], true]]);
  assert.equal(noticeFor({ hook_event_name: "Stop", stop_hook_active: true }, "api"), null);
});

test("Codex turn complete counts as done", () => {
  const n = noticeFor({ type: "agent-turn-complete", "last-assistant-message": "Fixed." }, "web", "de")!;
  assert.equal(n.title, "web");
  assert.equal(n.subtitle, "fertig · nichts offen");
  assert.equal(n.body, "Fixed.");
});

test("permission: allow is option 1, always only with a suggestion, deny is Esc", () => {
  const base = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test", description: "Run tests" } };
  const plainAsk = noticeFor(base, "api", "en")!;
  assert.deepEqual(plainAsk.actions.map((a) => [a.id, a.keys]), [["allow", ["1"]], ["deny", ["\u001b"]], ["denyWith", ["\u001b"]]]);
  assert.equal(plainAsk.body, "Run tests: npm test");
  const withSuggestion = noticeFor({ ...base, permission_suggestions: [{ type: "addRules" }] }, "api", "en")!;
  assert.deepEqual(withSuggestion.actions.map((a) => a.id), ["allow", "always", "deny", "denyWith"]);
});

test("question: one action per option plus free text after the last option", () => {
  const n = noticeFor(
    { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which pet?", header: "Pet", options: [{ label: "Cat" }, { label: "Dog" }], multiSelect: false }] } },
    "api",
    "en",
  )!;
  assert.deepEqual(n.actions.map((a) => [a.title, a.keys]), [["Cat", ["1"]], ["Dog", ["2"]], ["Own answer…", ["3"]]]);
});

test("question with several questions or multi select: informs only", () => {
  const q = { question: "Q?", options: [{ label: "A" }] };
  assert.deepEqual(noticeFor({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [q, q] } }, "x")!.actions, []);
  assert.deepEqual(noticeFor({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ ...q, multiSelect: true }] } }, "x")!.actions, []);
});

test("plain strips markdown and shortens", () => {
  assert.equal(plain("see [docs](http://x) and `code`"), "see docs and code");
  assert.equal(plain("a".repeat(300), 10).length, 10);
});

test("gist: the question at the end wins over a long report", () => {
  const report = "Workbase part A is done. 27 commits on the branch:\n\n- one\n- two\n- three\n\nThe PR is ready. Should I merge it now, or wait for the review?";
  assert.deepEqual(gist(report), { text: "The PR is ready. Should I merge it now, or wait for the review?", question: true });
  assert.deepEqual(gist("Intro.\n\nAll green, nothing left."), { text: "All green, nothing left.", question: false });
});

test("clearing: a late background hook never removes a newer notification", () => {
  const stop = { token: "t", at: 2000, tool: "" };
  assert.equal(outdatedBy(stop, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" }, 1500), false);
  assert.equal(outdatedBy(stop, { hook_event_name: "UserPromptSubmit" }, 2500), true);
});

test("clearing: another tool finishing in parallel keeps an approval open", () => {
  const bash = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } };
  const pending = { token: "t", at: 1000, tool: toolKey(bash) };
  assert.equal(outdatedBy(pending, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x" } }, 2000), false);
  assert.equal(outdatedBy(pending, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test", extra: 1 } }, 2000), true);
  assert.equal(outdatedBy(pending, { hook_event_name: "UserPromptSubmit" }, 2000), true);
});

test("Stop while the agent waits on its own timer: no notification yet", () => {
  const timer = { type: "shell", status: "running", command: "sleep 600" };
  assert.equal(noticeFor({ hook_event_name: "Stop", last_assistant_message: "Waiting.", background_tasks: [timer] }, "x"), null);
  assert.equal(waitingOnTimer({ background_tasks: [{ status: "running", command: "until curl -s localhost; do sleep 5; done" }] }), true);
});

test("Stop with a dev server, monitor or subagent in the background: notification, but no close", () => {
  for (const task of [{ type: "shell", status: "running", command: "npm run dev" }, { type: "agent", status: "running", description: "Review" }]) {
    const n = noticeFor({ hook_event_name: "Stop", last_assistant_message: "Done.", background_tasks: [task] }, "x", "en")!;
    assert.equal(n.subtitle, "done");
    assert.deepEqual(n.actions.map((a) => a.id), ["reply"]);
  }
});

test("colorWord names the nearest palette color", () => {
  assert.equal(colorWord("#ffca16", "de"), "gelb");
  assert.equal(colorWord("#4ccce6", "en"), "cyan");
  assert.equal(colorWord("#ff8dcc", "de"), "rosa");
});

test("allDone: only when nothing runs, nothing is scheduled and nothing is named as open", () => {
  assert.equal(allDone({}, "Alles erledigt, nichts mehr offen."), true);
  assert.equal(allDone({}, "Teil A ist fertig, Teil B läuft noch."), false);
  assert.equal(allDone({}, "Als Nächstes kommt das Review."), false);
  assert.equal(allDone({ session_crons: [{ id: "c" }] }, "Done."), false);
  assert.equal(allDone({ background_tasks: [{ id: "a" }] }, "Done."), false);
});
