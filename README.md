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
cd C:\Users\okzea\Documents\dictation-tray
npm.cmd install
```

Start the managed local STT service:

```powershell
cd C:\Users\okzea\Documents\dictation-tray
npm.cmd run stt:docker:up
```

Do everything in one command:

```powershell
pnpm start
```

That flow builds the Windows helpers, starts the managed local STT service when `stt.provider` is `local-http` and `stt.docker.autoStart` is enabled, waits for STT health, and then launches the tray.

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

`C:\Users\okzea\Documents\dictation-tray\dictation-tray.config.json`

You can override it with:

`DICTATION_TRAY_CONFIG`

Default hotkey env override:

`DICTATION_TRAY_HOTKEY`

Current provider config shape:

- `stt.provider`: currently `local-http`, `local`, or `wsl`
- `rewrite.provider`: currently `ollama` or `none`
- legacy `speech.stt`, `docker`, and top-level `ollama` config still load for backward compatibility

Compatibility note:

The config filename, state filenames, and `DICTATION_TRAY_*` env vars still use `dictation-tray` for backward compatibility.

## Notes

- Default shortcut is `Ctrl+Space`.
- Push-to-talk plays a short start chime when recording begins and an end chime when capture stops.
- While push-to-talk is actively recording, Windows output volume can be ducked and then restored to the exact prior level when capture stops.
- Ducking defaults to enabled at `30%`, and you can change or disable it from the tray or via `dictation.duckingEnabled` / `dictation.duckingLevel` in config.
- The default config uses `stt.provider = local-http` on `127.0.0.1:4591` and can auto-start the managed local STT service on launch.
- STT now sends a background keep-warm ping every `900000` ms by default (`15` minutes). Set `stt.keepWarmIntervalMs` to change it, or `0` to disable it.
- This repo does not include TTS at all.
- STT device/model switching in the tray is live only when STT uses the managed HTTP runtime on `:4591`.
- For `local` or `wsl` STT, the tray still works, but runtime switching is not available from the menu.
- Rewrite model selection is currently available for the Ollama provider only.
- If focused-window paste fails, the final text is copied to the clipboard as a fallback.
