# DicTray

DicTray is a standalone Windows tray app for fast local dictation.

It is meant to stay small:

- no main UI
- tray settings only
- push-to-talk
- provider-based STT selection
- provider-based rewrite selection
- focused-window-aware final text insertion

## Commands

Install dependencies:

```powershell
cd C:\Users\okzea\Documents\dictray
npm.cmd install
```

Do everything in one command:

```powershell
pnpm start
```

That flow builds the Windows helpers, warms the direct local STT path, and then launches the tray.

Build the Windows helpers:

```powershell
dotnet build scripts\windows-hotkey-hook\WindowsHotkeyHook.csproj -c Release
dotnet build scripts\windows-ui-automation\WindowsUiAutomation.csproj -c Release
dotnet build scripts\windows-system-volume\WindowsSystemVolume.csproj -c Release
```

Run the tray:

```powershell
npm.cmd run tray
```

Run syntax checks:

```powershell
npm.cmd run check
```

## Config

Default config path:

`C:\Users\okzea\Documents\dictray\dictation-tray.config.json`

You can override it with:

`DICTATION_TRAY_CONFIG`

Default hotkey env override:

`DICTATION_TRAY_HOTKEY`

Current provider config shape:

- `stt.provider`: currently `local` or `wsl`
- `rewrite.provider`: currently `ollama` or `none`
- legacy `speech.stt` and top-level `ollama` config still load for backward compatibility

Compatibility note:

The config filename, state filenames, and `DICTATION_TRAY_*` env vars still use `dictation-tray` for backward compatibility.

## Notes

- Default shortcut is `Ctrl+Space`.
- Push-to-talk plays a short start chime when recording begins and an end chime when capture stops.
- While push-to-talk is actively recording, Windows output volume can be ducked and then restored to the exact prior level when capture stops.
- Ducking defaults to enabled at `30%`, and you can change or disable it from the tray or via `dictation.duckingEnabled` / `dictation.duckingLevel` in config.
- The default config uses `stt.provider = local` with `scripts/faster_whisper_cli.py`.
- Existing `local-http` / `http` STT configs are treated as `local` during config loading so older setups keep working after the Docker removal.
- Direct local STT currently expects a working local Python environment with `faster-whisper` installed. When `stt.local.device = auto`, it will choose CUDA automatically if it is available and otherwise fall back to CPU.
- STT now sends a background keep-warm ping every `900000` ms by default (`15` minutes). Set `stt.keepWarmIntervalMs` to change it, or `0` to disable it.
- This repo does not include TTS at all.
- STT device/model changes currently happen through config plus restart rather than live tray switching.
- For `local` or `wsl` STT, the tray still reports the active device/model in the status line.
- Rewrite model selection is currently available for the Ollama provider only.
- If focused-window paste fails, the final text is copied to the clipboard as a fallback.
