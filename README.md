# sessionhue · terminal session colors

Give every terminal session its own color and title, so you can tell 10, 20 or 50 open sessions apart at a glance. Built for people who run many sessions in parallel, for example several Claude Code agents in different repos.

- **Color without touching your output.** The color lives in the tab or title bar, never as a background behind console text.
- **Accessible by default.** Wherever a label sits on the color, sessionhue keeps WCAG AAA contrast (7:1) and adjusts colors that fall short. A built-in checker shows the numbers.
- **Any color, fast.** Pick from a palette in an interactive menu, or use any `#hex`.
- **Presets per repo.** Save a look once, and every new session in that repo gets it automatically.
- **Suggestions from your history.** sessionhue looks at the repos you worked in (including past Claude Code sessions) and proposes a distinct color for each.
- **Scales to 50+ sessions.** After the 12 named colors, new colors are generated to be as different as possible from the ones already in use.

## Install

Requires Node.js 18 or newer and macOS (Linux works for kitty, WezTerm and generic terminals).

From the latest release:

```sh
npm install -g https://github.com/getitdone-gmbh/sessionhue/releases/download/v0.1.0/sessionhue-0.1.0.tgz
```

Or build it yourself, see [Development](#development).

Check it works:

```sh
sessionhue --help
```

`shue` is installed as a short alias for `sessionhue`.

## Quick start

```sh
# 1. Color the current tab
sessionhue blue api

# 2. Turn the repos you work in into presets (pick them from a list)
sessionhue suggest --save

# 3. Apply presets automatically whenever you cd into a repo
echo 'eval "$(sessionhue init zsh)"' >> ~/.zshrc

# 4. Optional: color Claude Code sessions on start
sessionhue claude --write
```

**For the most visible result, use iTerm2 with the Minimal theme.** The session color then fills the whole title bar of the window, readable from across the room. It is drawn by iTerm2 itself: no overlay, nothing behind your text.

```sh
defaults write com.googlecode.iterm2 TabStyleWithAutomaticOption -int 5   # iTerm2 > Settings > Appearance > Theme > Minimal
```

## Usage

```sh
sessionhue                    # interactive picker with suggestions and presets
sessionhue set blue api       # color this tab blue, title "api"
sessionhue blue api           # same, shorter
sessionhue set "#ff8800"      # any hex color (lifted to AAA if needed)
sessionhue set green --save   # and remember it for this repo
sessionhue reset              # back to the default look
```

### Presets and suggestions

```sh
sessionhue suggest            # repos you worked in, each with a proposed color
sessionhue suggest --save     # choose which ones become presets
sessionhue preset list
sessionhue preset add api --color teal --title "API" --match ~/code/api
sessionhue preset rm api
sessionhue apply              # apply the preset for the current folder
```

A preset matches a folder and everything inside it. The most specific match wins.

### Automatic coloring

The shell hook applies the matching preset when you `cd` into a repo. It also keeps your title in place when the shell or a prompt framework (oh-my-zsh, starship, ...) resets it on every prompt.

```sh
# ~/.zshrc
eval "$(sessionhue init zsh)"

# ~/.bashrc
eval "$(sessionhue init bash)"
```

The Claude Code hook colors the tab when a session starts and re-applies it after Claude Code renames the tab for a new topic:

```sh
sessionhue claude          # print the hook config
sessionhue claude --write  # add it to ~/.claude/settings.json
```

If you prefer your own titles over Claude Code's automatic ones, set `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`.

## Colors

```sh
sessionhue colors
```

`red`, `orange`, `amber`, `green`, `teal`, `cyan`, `blue`, `indigo`, `purple`, `pink`, `brown`, `gray`, or any `#hex`. German names work too (`rot`, `blau`, `gruen`, ...).

## Accessibility

Color is never the only signal: every session also has a text title.

When a label is drawn on top of the color (iTerm2 title bar, kitty and WezTerm tabs), the color must reach the configured contrast against black or white text. The default is **AAA (7:1)**. Every palette color passes. Custom colors that don't are shifted to the closest passing shade, and sessionhue tells you about it.

```sh
sessionhue check "#0090ff"
#  #0090ff with #000000 text: 6.43:1
#    AA  (4.5:1) pass
#    AAA (7:1)   fail
#    closest AAA shade: #1499ff (7.03:1)

sessionhue check "#e5484d" --text "#ffffff"   # check a specific text color
```

`check` exits with code 1 when the color fails the configured level, so you can use it in scripts.

## Terminal support

| Terminal | Indicator | Status |
| --- | --- | --- |
| iTerm2 | Colored tab and title bar (Minimal theme: whole title bar) + title | tested |
| Terminal.app | Colored dot in the tab title, e.g. `🔵 api` | tested |
| kitty | Colored tab with black/white label + title (needs `allow_remote_control yes`) | untested |
| WezTerm | Colored tab via user vars + title (snippet below) | untested |
| Ghostty, others | Colored dot in the tab title | untested |

Terminal.app and Ghostty cannot color tabs, so the closest of nine colored dots is used there. Reports and fixes for the untested terminals are very welcome.

### WezTerm snippet

```lua
wezterm.on("format-tab-title", function(tab)
  local vars = tab.active_pane.user_vars
  local title = tab.active_pane.title
  if vars.sessionhue_bg and vars.sessionhue_bg ~= "" then
    return {
      { Background = { Color = vars.sessionhue_bg } },
      { Foreground = { Color = vars.sessionhue_fg } },
      { Text = " " .. title .. " " },
    }
  end
  return title
end)
```

## Configuration

`~/.config/sessionhue/config.json` (change the folder with `SESSIONHUE_HOME`):

```json
{
  "contrast": "AAA",
  "autoColorUnknownRepos": false,
  "presets": [
    { "name": "api", "color": "#0bd8b6", "title": "API", "match": ["/Users/me/code/api"] }
  ]
}
```

- `contrast`: `"AAA"` (7:1), `"AA"` (4.5:1) or `"off"`.
- `autoColorUnknownRepos`: on `apply`, give repos without a preset their suggested color.

## Uninstall

```sh
npm uninstall -g sessionhue
rm -rf ~/.config/sessionhue
```

Then remove the `eval "$(sessionhue init zsh)"` line from your shell config and the `sessionhue apply` hooks from `~/.claude/settings.json`, if you added them.

## Development

```sh
git clone https://github.com/getitdone-gmbh/sessionhue.git
cd sessionhue
npm install
npm run build
npm test
npm link        # use your local build as the global `sessionhue`
```

## License

[0BSD](LICENSE): do whatever you want with it. No conditions, no attribution required.
