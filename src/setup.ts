import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * macOS integrations used by `sessionhue setup`: iTerm2 settings, the optional
 * AAA profile, and a Spotlight launcher so "terminal" opens iTerm2.
 * None of this touches the user's shell, prompt or plugins.
 */

const ITERM_DOMAIN = "com.googlecode.iterm2";
const ITERM_APP = "/Applications/iTerm.app";
export const ITERM_PROFILE_GUID = "5E5510E0-4A3E-4C2B-9A11-AAA000000001";
/**
 * /Applications is searched by Spotlight, Alfred and Raycast alike; fall back
 * to ~/Applications when it is not writable for this user.
 */
function launcherPath(): string {
  try {
    fs.accessSync("/Applications", fs.constants.W_OK);
    return "/Applications/Terminal iTerm.app";
  } catch {
    return path.join(os.homedir(), "Applications", "Terminal iTerm.app");
  }
}
const OLD_LAUNCHER = path.join(os.homedir(), "Applications", "Terminal iTerm.app");
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function succeeds(cmd: string, args: string[]): boolean {
  try {
    run(cmd, args);
    return true;
  } catch {
    return false;
  }
}

export const isMac = () => process.platform === "darwin";
export const itermInstalled = () => fs.existsSync(ITERM_APP);
export const itermRunning = () => succeeds("pgrep", ["-x", "iTerm2"]);
export const brewAvailable = () => succeeds("which", ["brew"]);

export function installIterm(): void {
  execFileSync("brew", ["install", "--cask", "iterm2"], { stdio: "inherit" });
}

/** iTerm2 rewrites its preferences on quit, so settings must be written while it is closed. */
export function quitIterm(): void {
  succeeds("osascript", ["-e", 'tell application id "com.googlecode.iterm2" to quit']);
  for (let i = 0; i < 50 && itermRunning(); i++) execFileSync("sleep", ["0.2"]);
}

/** Minimal theme: the tab color fills the whole title bar. */
export function setMinimalTheme(): void {
  run("defaults", ["write", ITERM_DOMAIN, "TabStyleWithAutomaticOption", "-int", "5"]);
}

export function installProfile(makeDefault: boolean): string {
  const dir = path.join(os.homedir(), "Library", "Application Support", "iTerm2", "DynamicProfiles");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(PACKAGE_ROOT, "extras", "iterm2-light-aaa.json"), path.join(dir, "sessionhue-light-aaa.json"));
  if (makeDefault) run("defaults", ["write", ITERM_DOMAIN, "Default Bookmark Guid", "-string", ITERM_PROFILE_GUID]);
  return dir;
}

/**
 * A tiny app named "Terminal iTerm" with the iTerm2 icon. Spotlight, Alfred and
 * Raycast list it when you type "terminal", so that habit keeps working.
 */
export function installLauncher(): string {
  const LAUNCHER = launcherPath();
  if (OLD_LAUNCHER !== LAUNCHER) fs.rmSync(OLD_LAUNCHER, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true });
  fs.rmSync(LAUNCHER, { recursive: true, force: true });
  run("osacompile", [
    "-o",
    LAUNCHER,
    "-e",
    'tell application id "com.googlecode.iterm2"\n\tactivate\n\tif (count of windows) = 0 then create window with default profile\nend tell',
  ]);
  const icon = fs.readdirSync(path.join(ITERM_APP, "Contents", "Resources")).find((f) => /App Icon.*\.icns$/i.test(f));
  if (icon) fs.copyFileSync(path.join(ITERM_APP, "Contents", "Resources", icon), path.join(LAUNCHER, "Contents", "Resources", "applet.icns"));
  // No Dock icon of its own: it only hands over to iTerm2.
  succeeds("/usr/libexec/PlistBuddy", ["-c", "Add :LSUIElement bool true", path.join(LAUNCHER, "Contents", "Info.plist")]);
  succeeds("codesign", ["--force", "-s", "-", LAUNCHER]);
  succeeds("touch", [LAUNCHER]);
  succeeds("mdimport", [LAUNCHER]);
  return LAUNCHER;
}

export function removeLauncher(): void {
  fs.rmSync(launcherPath(), { recursive: true, force: true });
  fs.rmSync(OLD_LAUNCHER, { recursive: true, force: true });
}

/** Adds the shell hook line to the rc file once. */
export function installShellHook(shell: "zsh" | "bash"): string {
  const rc = path.join(os.homedir(), shell === "zsh" ? ".zshrc" : ".bashrc");
  const line = `eval "$(sessionhue init ${shell})"`;
  const current = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
  if (!current.includes(line)) fs.appendFileSync(rc, `${current.endsWith("\n") || !current ? "" : "\n"}\n# sessionhue: terminal session colors\n${line}\n`);
  return rc;
}
