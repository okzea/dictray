# Native Capture Migration

## Goal

Move microphone capture out of the legacy overlay renderer while preserving:

- push-to-talk behavior
- GNOME extension and tray integration
- local STT warmup and GPU runtime selection
- microphone processing requirements such as echo cancellation, automatic gain control, and noise suppression

## Why

The current voice window mixes three responsibilities:

- capture and microphone device management
- visual feedback and earcons
- submission glue back into the tray core

That coupling makes CPU work in the overlay harder to control and blocks a native capture path.

## Target Product Shape

### `dictray-core`

- owns hotkeys, session state, STT, rewrite, insertion, settings, and status bridge

### `dictray-capture`

- owns microphone access, push-to-talk recording, level metering, and capture-time DSP
- eventually runs as a native helper instead of inside Chromium

### `dictray-overlay`

- only renders state and feedback
- never owns microphone access

## Phases

### Phase 1: Renderer Split

- [x] Document the migration plan and target process model.
- [x] Split the current voice window into:
  - feedback module
  - capture backend module
  - thin renderer bootstrap
- [x] Keep the capture boundary stable while the native helper replaces the Chromium path.

### Phase 2: Core Capture Contract

- [x] Define a process-level IPC contract between `dictray-core` and `dictray-capture`.
- [x] Move submission, input-device reporting, and recording state events onto that contract.
- [x] Add a process boundary so the tray can move off the renderer-owned capture path.

### Phase 3: Native Linux Capture Helper

- [x] Build a Linux-native capture helper.
- [x] Support required microphone processing features.
- [x] Emit encoded audio chunks and live level updates to the core.
- [x] Keep the overlay as a pure feedback subscriber.

### Phase 4: Overlay Hard Separation

- [ ] Stop prewarming or owning the microphone from the overlay renderer.
- [ ] Make the overlay optional and fully passive.
- [ ] Keep earcons and visual feedback independent of capture implementation.

## Risks

- Browser DSP and native DSP may not match exactly in subjective audio behavior.
- Native helper packaging on Linux will need tighter runtime integration than the current renderer path.
- Input-device enumeration and permission behavior will differ once capture leaves Chromium.

## Current Status

This repository now has:

- `src/capture-protocol.mjs`
- `src/capture-bridge.mjs`
- `src/native-capture-helper.mjs`

The capture path now runs through the shared native helper contract end to end. The Linux backend has a live-validated implementation using `pactl` for device discovery and a GStreamer capture pipeline with `webrtcdsp`, `webrtcechoprobe`, and live level telemetry. It records, submits WAV audio to the tray core, and drives the overlay through the full start/stop cycle in the real tray session without any legacy renderer in the loop.
