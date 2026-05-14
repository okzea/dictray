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
glib-compile-schemas ~/.local/share/gnome-shell/extensions/dictray-gnome-panel@okzea/schemas
gnome-extensions enable dictray-gnome-panel@okzea
```

Then restart GNOME Shell (X11: Alt+F2, `r`, Enter; Wayland: log out and back in).

Open the persistent settings window with:

```bash
gnome-extensions prefs dictray-gnome-panel@okzea
```

GNOME caches whether an extension has preferences. When adding `prefs.js` to an already installed copy, restart GNOME Shell or log out and back in before opening preferences.

## Controls

- Top bar button shows current dictation status.
- Menu item toggles start/stop.
- Preferences opens the GNOME settings window for less frequent controls.
- You can still use tray shortcuts and all normal app features.
