# DicTray GNOME Panel Extension

This extension is a small companion widget for the GNOME top bar.

It reads app state from:

- `~/.config/dictray/gnome-panel/status.json`

and writes commands to:

- `~/.config/dictray/gnome-panel/command.json`

## Install

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r gnome-panel-extension ~/.local/share/gnome-shell/extensions/dictray-gnome-panel@okzea
gnome-extensions refresh
gnome-extensions enable dictray-gnome-panel@okzea
```

Then restart GNOME Shell (X11: Alt+F2, `r`, Enter; Wayland: log out and back in).

## Controls

- Top bar button shows current dictation status.
- Menu item toggles start/stop.
- You can still use tray shortcuts and all normal app features.
