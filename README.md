<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/dictray-logo-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/dictray-logo-light.png">
  <img alt="DicTray logo" src="assets/brand/dictray-logo-light.png" width="96">
</picture>

# DicTray

DicTray is a standalone tray/menu-bar app for fast local dictation on Linux and macOS.

It is intentionally small:

- no main UI
- tray settings only
- push-to-talk
- built-in speech to text
- provider-based rewrite selection
- focused-window-aware final text insertion

## Regular Usage

DicTray lives in the OS tray or menu bar. The app is meant to stay out of the way until you use the global dictation shortcut.

1. Launch DicTray.
2. Finish Quick Start from the tray/menu-bar menu.
3. Keep the target app focused.
4. Use the configured push-to-talk shortcut, `Ctrl+Space` by default, while speaking.
5. DicTray inserts the final text into the focused window.

Push-to-talk plays a short start chime when recording begins and an end chime when capture stops. If focused-window insertion is blocked, DicTray keeps the final text on the clipboard as a fallback.

## Developer Quick Start

These commands are for running DicTray from a source checkout.

Install dependencies:

```bash
pnpm install
```

macOS development also needs `ffmpeg` for AVFoundation microphone capture:

```bash
brew install ffmpeg
```

Launch the development tray:

```bash
pnpm start
```

This auto-prepares the local Faster-Whisper runtime when needed, exits any existing DicTray instance, and launches the tray/menu-bar process. The tray process owns local STT warmup and the managed speech daemon.

Run the tray directly:

```bash
pnpm tray
```

Run syntax checks:

```bash
pnpm check
```

## Settings

Use the tray/menu-bar menu to change the shortcut, microphone, STT device/model, volume ducking, and rewrite settings. The default rewrite provider is `none`, so DicTray does not depend on Ollama unless cleanup is enabled.

On macOS, grant Accessibility permission so DicTray can control the focused app, and grant Microphone permission when macOS prompts for capture. If paste or the hotkey is blocked, open System Settings > Privacy & Security > Accessibility and enable DicTray.

On GNOME Linux, packaged builds install a product-managed GNOME extension payload and autostart entry on first launch. The extension provides the top-bar control, global shortcut, and fixed dictation overlay.

## Packaging

Prepare a bundle-ready private runtime:

```bash
pnpm bundle:runtime
```

That stages bundle resources under `build/bundled-runtime/`, including the local STT runtime, the Linux headless core, and the Linux Node runtime when run on Linux. When packaged resources or a local staged runtime are present, DicTray automatically prefers those bundled assets over the user's global `python`.

Build Linux distributables:

```bash
pnpm dist:linux
```

Build a macOS `.dmg` with bundled Node, ffmpeg, Swift helpers, and the local STT runtime:

```bash
pnpm dist:mac
```

The macOS builder copies `ffmpeg` and its non-system dylibs into `DicTray.app/Contents/Resources/runtime/ffmpeg`. It resolves `ffmpeg` from `DICTATION_TRAY_BUNDLE_FFMPEG`, `DICTATION_TRAY_CAPTURE_FFMPEG_BIN`, `STT_FFMPEG_BIN`, or `ffmpeg` on `PATH`.

Regenerate the app icon assets from the SVG source:

```bash
pnpm icon:export
```

The brand mark variants live under `assets/brand/`: `dictray-logo-dark.*` is white for dark surfaces, `dictray-logo-light.*` is black for light surfaces, `dictray-logo-active.*` is green for active states, and `dictray-logo-template.png` is used where the OS handles menu-bar tinting.

## Advanced Config

Default config path in development:

`./dictation-tray.config.json`

You can override it with:

`DICTATION_TRAY_CONFIG`

Default hotkey env override:

`DICTATION_TRAY_HOTKEY`

Current provider config shape:

- `stt.provider`: `local` is the standard app path
- `rewrite.provider`: currently `none` or `ollama`
- legacy `speech.stt` and top-level `ollama` still load for backward compatibility

Compatibility note:

The config filename, state filenames, and `DICTATION_TRAY_*` env vars still use `dictation-tray` for backward compatibility.

## Platform Notes

- While push-to-talk is actively recording, output volume can be ducked and then restored to the exact prior level when capture stops.
- Ducking defaults to enabled at `30%`, and you can change or disable it from the tray or via `dictation.duckingEnabled` / `dictation.duckingLevel` in config.
- The default config uses `stt.provider = local` with `scripts/faster_whisper_cli.py`.
- Legacy `local-http` / `http` STT configs are treated as `local` during config loading so existing installations keep working.
- Direct local STT currently expects a working local Python environment with `faster-whisper` installed. When `stt.local.device = auto`, it will choose CUDA automatically if it is available and otherwise fall back to CPU.
- `pnpm bundle:runtime` will try to auto-create a private bundled Python runtime and install `faster-whisper` into it. If you already have a private runtime you want to reuse, point `DICTATION_TRAY_BUNDLED_PYTHON_DIR` or `DICTATION_TRAY_BUNDLED_PYTHON` at it instead. Use `DICTATION_TRAY_BUNDLED_PYTHON_BOOTSTRAP` to choose the bootstrap interpreter, and `DICTATION_TRAY_BUNDLED_STT_MODEL_DIR` to stage a local model cache into the bundle.
- Packaged builds that include a bundled STT runtime automatically prefer `stt.provider = local` unless you explicitly override `DICTATION_TRAY_STT_PROVIDER`.
- STT now sends a background keep-warm ping every `900000` ms by default (`15` minutes). Set `stt.keepWarmIntervalMs` to change it, or `0` to disable it.
- This repo does not include TTS at all.
- STT device/model changes can be changed live from the tray, macOS menu bar, or GNOME panel when the active STT provider supports runtime preferences.
- For local STT, the tray reports the active device/model in the status line.
- Rewrite model selection is currently available for the optional Ollama provider only.
- macOS uses small native Swift helpers for the menu bar, Quick Start window, floating voice overlay, and focused-app paste, plus `pbcopy` for clipboard staging and `ffmpeg -f avfoundation` for microphone capture. Packaged builds use a DicTray-branded accessibility helper for global hotkeys and paste automation.
- On GNOME Linux, DicTray now defaults to the native capture backend, uses the Shell extension for the fixed dictation overlay, and opens microphone setup / Quick Start as native GTK utilities.
- Packaged Linux builds are pure Node bundles under `dist/DicTray-linux-x64/` and let the GNOME extension launch DicTray if the app is not already running.
- For GNOME extension development, copy `gnome-panel-extension/` to `~/.local/share/gnome-shell/extensions/dictray-gnome-panel@okzea`, enable it with `gnome-extensions`, restart GNOME Shell, and run `pnpm gnome:reload` after local extension edits.
