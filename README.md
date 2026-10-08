# sessionhue · terminal session colors

Give every terminal session its own color and title, so you can tell ten open tabs apart at a glance. Built for people who run many parallel sessions, for example several Claude Code agents in different repos.

- **Color without touching your output.** The color is a tab indicator, never a background behind console text.
- **Accessible by default.** Wherever a label sits on the color, sessionhue keeps WCAG AAA contrast (7:1) and adjusts colors that don't reach it. A built-in checker tells you why.
- **Any color, fast.** Pick from a palette in an interactive menu, or use any `#hex`.
- **Presets per repo.** Save a look once and every new session in that repo gets it automatically.
- **Suggestions from your history.** sessionhue reads which repos you worked in (including past Claude Code sessions) and proposes distinct colors for them.

## Install

```sh
npm install -g sessionhue
```

Requires Node 18+. `shue` is a short alias for `sessionhue`.

## Usage

```sh
sessionhue                    # interactive picker with suggestions and presets
sessionhue set blue api       # color this tab blue, title "api"
sessionhue blue api           # same, shorter
sessionhue set "#ff8800"      # any hex color (lifted to AAA if needed)
sessionhue set green --save   # and remember it for this repo
sessionhue reset
```

### Presets and suggestions

```sh
sessionhue suggest            # repos you worked in, with a proposed color each
sessionhue suggest --save     # pick which ones become presets
sessionhue preset list
sessionhue preset add api --color teal --title "API" --match ~/code/api
sessionhue preset rm api
sessionhue apply              # apply the preset for the current folder
```

A preset matches a folder and everything inside it. The most specific match wins.

### Automatic coloring

Shell hook, colors the tab when you `cd` into a repo with a preset, and keeps your title when the shell (oh-my-zsh, starship, ...) resets it on every prompt:

```sh
# ~/.zshrc
eval "$(sessionhue init zsh)"
```

Claude Code hook, colors the tab when a session starts and re-applies it after Claude Code renamed the tab:

```sh
sessionhue claude          # print the hook config
sessionhue claude --write  # add it to ~/.claude/settings.json
```

If you prefer your own titles over Claude Code's automatic ones, set `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`.

## Accessibility

Color is never the only signal: every session also has a text title.

When a label is drawn on top of the color (colored tabs in iTerm2, kitty, WezTerm), the color must reach the configured contrast against black or white text. The default is **AAA (7:1)**. Every palette color passes; custom colors that don't are shifted to the closest passing shade, and sessionhue tells you.

```sh
sessionhue check "#0090ff"
#  #0090ff with #000000 text: 6.43:1
#    AA  (4.5:1) pass
#    AAA (7:1)   fail
#    closest AAA shade: #1499ff (7.03:1)

sessionhue check "#e5484d" --text "#ffffff"   # check a specific text color
sessionhue colors                             # palette with ratings
```

`check` exits with code 1 when the color fails the configured level, so it can be used in scripts.

## Terminal support

| Terminal | Indicator |
| --- | --- |
| iTerm2 | Colored tab + title |
| kitty | Colored tab with black/white label + title (needs `allow_remote_control yes`) |
| WezTerm | Colored tab via user vars + title (snippet below) |
| Terminal.app, Ghostty, others | Colored dot in the tab title, e.g. `🔵 api` |

Terminal.app and Ghostty cannot color tabs, so the closest of nine colored dots is used there.

**Best visibility: iTerm2 with the Minimal theme** (Settings → Appearance → Theme → Minimal). The tab color then fills the whole title bar of the window, readable from across the room, and it is drawn by iTerm2 itself: no overlay, nothing behind your text.

```sh
defaults write com.googlecode.iterm2 TabStyleWithAutomaticOption -int 5   # Minimal theme
```

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

`~/.config/sessionhue/config.json` (override the folder with `SESSIONHUE_HOME`):

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

## License

MIT
