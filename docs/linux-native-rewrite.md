# Linux Native Rewrite

## Goal

Move the Linux product to a GNOME-native shell and Node runtime for:

- the top-bar control surface
- the fixed on-screen dictation overlay
- Linux-first startup and packaging defaults

## Current Direction

The Linux rewrite now targets GNOME-native UI throughout:

- the GNOME Shell extension owns the panel button and hotkey
- the GNOME Shell extension now owns the fixed dictation overlay
- local capture defaults to the native Linux helper
- the shipped Linux product now runs as a GNOME extension + Node core pair

## Product Shape

### GNOME Shell Extension

- top-bar indicator
- global shortcut
- fixed overlay rendered by Shell UI
- command bridge to the core process

### Core Process

- session state machine
- STT warmup and runtime switching
- rewrite and insertion
- status publishing for Shell UI

### Native Capture Helper

- Linux microphone capture
- DSP via GStreamer / WebRTC DSP
- input-device discovery and live level telemetry

## Phases

### Phase 1: GNOME-Native Overlay

- [x] Move the listening overlay into the GNOME Shell extension.
- [x] Publish overlay state from the core through the existing GNOME panel status file.
- [x] Default Linux to the native capture backend.

### Phase 2: Linux-Only UI Cleanup

- [x] Replace the old input preview window with a native GNOME surface.
- [x] Replace onboarding with a Linux-native flow.
- [x] Remove the legacy Linux fallback window code paths that are no longer needed.

### Phase 3: Legacy Shell Removal

- [x] Extract the Linux core startup path from the legacy tray host.
- [x] Launch the Linux core directly under Node in packaged builds.
- [x] Keep the extension and core as the shipped Linux product pair.

## Notes

- This path is intentionally Linux-first and GNOME-first.
- A fixed overlay on Wayland is reliable in Shell UI; it is not reliable as a regular GTK window without layer-shell.
- Linux input setup and Quick Start now launch as GJS/GTK utilities through a file bridge under `~/.config/dictray/linux-ui/`.
- The Linux headless core now runs directly under `node` in development and is the default `npm run tray` path on Linux.
- Packaged Linux builds now ship as a pure Node bundle with staged runtime resources under `dist/DicTray-linux-x64/`.
