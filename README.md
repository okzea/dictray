# DicTray

DicTray is a standalone tray/menu-bar app for fast local dictation on Linux and macOS, with Windows helper code still kept in the repo.

It is meant to stay small:

- no main UI
- tray settings only
- push-to-talk
- built-in speech to text
- provider-based rewrite selection
- focused-window-aware final text insertion

## Commands

Install dependencies:

```bash
pnpm install
```

macOS also needs `ffmpeg` for AVFoundation microphone capture:

```bash
brew install ffmpeg
```

Do everything in one command:

```bash
pnpm start
```

That flow auto-prepares the local Faster-Whisper runtime when needed, warms the direct local STT path, exits any existing DicTray instance, and launches the tray/menu-bar process.

Prepare a bundle-ready private runtime:

```powershell
pnpm bundle:runtime
```

That stages a private STT runtime under `build/bundled-runtime/` and publishes the Windows helper executables there. When packaged resources or a local staged runtime are present, DicTray automatically prefers those bundled assets over the user's global `python`.

Build Linux distributables:

```bash
pnpm dist:linux
```

Build a macOS `.dmg` with bundled Node, ffmpeg, Swift helpers, and the local STT runtime:

```bash
pnpm dist:mac
```

The macOS builder copies `ffmpeg` and its non-system dylibs into `DicTray.app/Contents/Resources/runtime/ffmpeg`. It resolves `ffmpeg` from `DICTATION_TRAY_BUNDLE_FFMPEG`, `DICTATION_TRAY_CAPTURE_FFMPEG_BIN`, `STT_FFMPEG_BIN`, or `ffmpeg` on `PATH`.

Build the Windows helpers:

```powershell
dotnet build scripts\windows-hotkey-hook\WindowsHotkeyHook.csproj -c Release
dotnet build scripts\windows-ui-automation\WindowsUiAutomation.csproj -c Release
dotnet build scripts\windows-system-volume\WindowsSystemVolume.csproj -c Release
```

Run the tray:

```bash
pnpm tray
```

Run syntax checks:

```bash
pnpm check
```

Regenerate the app icon assets from the SVG source:

```powershell
pnpm icon:export
```

The Windows tray uses the generated `assets/app-icon.ico`.

## Voice-Friendly Developer Aliases

If you use DicTray inside a terminal, short commands like `cd`, `ls`, `rg`, or `gs` are usually worse for speech than full words.

The better pattern is:

- prefer full words over initials
- prefer distinct multi-syllable names over one-letter abbreviations
- avoid aliases that sound too close to normal prose
- keep one spoken phrase mapped to one shell action

Recommended PowerShell profile functions:

```powershell
function goto {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PathParts)
  $target = if ($PathParts.Count) { $PathParts -join ' ' } else { '.' }
  Set-Location $target
}

function back {
  Set-Location ..
}

function list {
  Get-ChildItem -Force @Args
}

function findtext {
  rg @Args
}

function findfile {
  if ($Args.Count -eq 0) {
    rg --files
    return
  }
  rg --files | rg ($Args -join ' ')
}

function status {
  git status --short
}

function branchname {
  git branch --show-current
}

function startapp {
  pnpm start
}

function onboard {
  pnpm start:ob
}

function checkapp {
  npm.cmd run check
}

function packwin {
  pnpm pack:win
}
```

Put those in your PowerShell profile at `$PROFILE`.

Good voice-first replacements:

- use `goto tray` instead of `cd tray`
- use `list` instead of `ls`
- use `findtext hotkey` instead of `rg hotkey`
- use `findfile main` instead of `rg --files | rg main`
- use `status` instead of `git status`
- use `branchname` instead of `git branch --show-current`
- use `startapp` instead of `pnpm start`
- use `checkapp` instead of `npm run check`

If you want to take this further, keep adding aliases that sound like plain spoken verbs. `goto`, `list`, `status`, `findtext`, and `findfile` are the highest-value ones.

## Config

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

## Notes

- Default shortcut is `Ctrl+Space`.
- Push-to-talk plays a short start chime when recording begins and an end chime when capture stops.
- While push-to-talk is actively recording, output volume can be ducked and then restored to the exact prior level when capture stops.
- Ducking defaults to enabled at `30%`, and you can change or disable it from the tray or via `dictation.duckingEnabled` / `dictation.duckingLevel` in config.
- The default config uses `stt.provider = local` with `scripts/faster_whisper_cli.py`.
- The default config keeps `rewrite.provider = none`, so DicTray does not depend on Ollama unless you explicitly turn on cleanup.
- Existing `local-http` / `http` STT configs are treated as `local` during config loading so older setups keep working after the Docker removal.
- Direct local STT currently expects a working local Python environment with `faster-whisper` installed. When `stt.local.device = auto`, it will choose CUDA automatically if it is available and otherwise fall back to CPU.
- `pnpm bundle:runtime` will try to auto-create a private bundled Python runtime and install `faster-whisper` into it. If you already have a private runtime you want to reuse, point `DICTATION_TRAY_BUNDLED_PYTHON_DIR` or `DICTATION_TRAY_BUNDLED_PYTHON` at it instead. Use `DICTATION_TRAY_BUNDLED_PYTHON_BOOTSTRAP` to choose the bootstrap interpreter, and `DICTATION_TRAY_BUNDLED_STT_MODEL_DIR` to stage a local model cache into the bundle.
- Packaged builds that include a bundled STT runtime automatically prefer `stt.provider = local` unless you explicitly override `DICTATION_TRAY_STT_PROVIDER`.
- STT now sends a background keep-warm ping every `900000` ms by default (`15` minutes). Set `stt.keepWarmIntervalMs` to change it, or `0` to disable it.
- This repo does not include TTS at all.
- STT device/model changes can be changed live from the tray, macOS menu bar, or GNOME panel when the active STT provider supports runtime preferences.
- For local STT, the tray reports the active device/model in the status line.
- Rewrite model selection is currently available for the optional Ollama provider only.
- If focused-window paste fails, the final text is copied to the clipboard as a fallback.
- macOS uses small native Swift helpers for the menu bar, global hotkey hook, Quick Start window, floating voice overlay, and focused-app paste, plus `pbcopy` for clipboard staging and `ffmpeg -f avfoundation` for microphone capture.
- On macOS, grant Accessibility permission when prompted so the hotkey hook and paste automation can control the focused app. If paste or the hotkey is blocked, open System Settings > Privacy & Security > Accessibility and enable DicTray or its bundled helper. Grant Microphone permission to DicTray when macOS prompts for capture.
- GNOME (Linux) can show DicTray in the top bar using the companion extension under `gnome-panel-extension/`.
- On GNOME Linux, DicTray now defaults to the native capture backend, uses the Shell extension for the fixed dictation overlay, and opens microphone setup / Quick Start as native GTK utilities.
- Packaged Linux builds are now pure Node bundles under `dist/DicTray-linux-x64/`, install a product-managed GNOME extension payload and autostart entry on first launch, and let the extension launch DicTray if the app is not already running.
  1) Copy it to `~/.local/share/gnome-shell/extensions/dictray-gnome-panel@okzea`
  2) `gnome-extensions enable dictray-gnome-panel@okzea`
  3) Log out / log in on Wayland (or `Alt+F2`, `r`, Enter on X11)
  4) After local extension edits, run `pnpm gnome:reload`
