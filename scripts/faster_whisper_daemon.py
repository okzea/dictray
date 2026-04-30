#!/usr/bin/env python3

from __future__ import annotations

from array import array
import argparse
import base64
import gc
import json
import math
import os
import subprocess
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    import ctranslate2
except Exception:  # pragma: no cover - optional import surface
    ctranslate2 = None

try:
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
except ModuleNotFoundError as error:  # pragma: no cover - optional import surface
    missing = getattr(error, "name", "") or "faster_whisper"
    WhisperModel = None
    decode_audio = None
    IMPORT_ERROR = f"Missing Python dependency '{missing}'. Install faster-whisper in the Python environment used by DicTray."
except Exception as error:  # pragma: no cover - optional import surface
    WhisperModel = None
    decode_audio = None
    IMPORT_ERROR = str(error)
else:
    IMPORT_ERROR = ""

MODEL_CACHE = {}
ACTIVE_RUNTIME = None
STATE_LOCK = threading.Lock()
TRANSCRIBE_LOCK = threading.Lock()
FFMPEG_BIN = os.getenv("STT_FFMPEG_BIN", "ffmpeg")
AUTO_GAIN_TARGET_PEAK_DB = float(os.getenv("STT_AUTO_GAIN_TARGET_PEAK_DB", "-3"))
AUTO_GAIN_TARGET_RMS_DB = float(os.getenv("STT_AUTO_GAIN_TARGET_RMS_DB", "-24"))
AUTO_GAIN_THRESHOLD_PEAK_DB = float(os.getenv("STT_AUTO_GAIN_THRESHOLD_PEAK_DB", "-18"))
AUTO_GAIN_THRESHOLD_RMS_DB = float(os.getenv("STT_AUTO_GAIN_THRESHOLD_RMS_DB", "-30"))
MAX_AUTO_GAIN_DB = float(os.getenv("STT_MAX_AUTO_GAIN_DB", "40"))


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def read_json_bytes(raw: bytes) -> dict:
    if not raw:
        return {}
    parsed = json.loads(raw.decode("utf-8"))
    return parsed if isinstance(parsed, dict) else {}


def decode_header_base64(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return base64.b64decode(text, validate=True).decode("utf-8").strip()
    except Exception:
        return ""


def error_text(error: Exception) -> str:
    return str(error or "").strip()


def cuda_device_count() -> int:
    if ctranslate2 is None:
        return 0
    try:
        return max(0, int(ctranslate2.get_cuda_device_count()))
    except Exception:
        return 0


def normalize_device(value: str) -> str:
    requested = (value or "auto").strip().lower()
    if requested == "gpu":
        requested = "cuda"
    if requested == "auto":
        return "cuda" if cuda_device_count() > 0 else "cpu"
    if requested not in {"cpu", "cuda"}:
        raise ValueError("device must be one of: auto, cpu, cuda")
    if requested == "cuda" and cuda_device_count() <= 0:
        raise ValueError("cuda was requested but no CUDA-capable device is available")
    return requested


def normalize_compute_type(requested: str, device: str) -> str:
    value = (requested or "auto").strip().lower()
    if value in {"", "auto"}:
        return "float16" if device == "cuda" else "int8"
    return value


def allow_cpu_fallback(requested_device: str) -> bool:
    return (requested_device or "auto").strip().lower() in {"", "auto"}


def cuda_runtime_unavailable(message: str) -> bool:
    return bool(message) and (
        "cublas" in message.lower()
        or "cudnn" in message.lower()
        or ("cuda" in message.lower() and ("not found" in message.lower() or "cannot be loaded" in message.lower() or "load failed" in message.lower()))
    )


def ensure_whisper_imported() -> None:
    if WhisperModel is None:
        raise RuntimeError(IMPORT_ERROR or "faster-whisper is unavailable")


def input_extension(content_type: str) -> str:
    content_type = (content_type or "").split(";", 1)[0].strip().lower()
    if content_type == "audio/webm":
        return ".webm"
    if content_type == "audio/ogg":
        return ".ogg"
    if content_type in {"audio/wav", "audio/x-wav"}:
        return ".wav"
    if content_type in {"audio/mp4", "audio/m4a"}:
        return ".m4a"
    if content_type == "audio/mpeg":
        return ".mp3"
    return ".bin"


def amplitude_dbfs(amplitude: float) -> float:
    if amplitude <= 0:
        return -120.0
    return 20.0 * math.log10(min(amplitude, 1.0))


def decode_audio_to_wav(raw_path: Path, wav_path: Path) -> None:
    try:
        audio = decode_audio(str(raw_path), sampling_rate=16000)
        pcm = array(
            "h",
            [
                -32768 if float(sample) <= -1.0 else max(-32768, min(32767, int(round(float(sample) * 32767.0))))
                for sample in audio
            ],
        )
        if os.sys.byteorder != "little":
            pcm.byteswap()
        with wave.open(str(wav_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16000)
            handle.writeframes(pcm.tobytes())
        return
    except Exception:
        pass

    subprocess.run(
        [
            FFMPEG_BIN,
            "-v",
            "error",
            "-y",
            "-i",
            str(raw_path),
            "-ac",
            "1",
            "-ar",
            "16000",
            str(wav_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def analyze_and_gain_wav(wav_path: Path) -> dict[str, float | int]:
    with wave.open(str(wav_path), "rb") as handle:
        params = handle.getparams()
        frames = handle.readframes(handle.getnframes())

    samples = array("h")
    samples.frombytes(frames)
    if os.sys.byteorder != "little":
        samples.byteswap()

    sample_count = len(samples)
    if sample_count <= 0:
        return {
            "sampleCount": 0,
            "inputPeakDb": -120.0,
            "inputRmsDb": -120.0,
            "appliedGainDb": 0.0,
        }

    peak_level = max(abs(int(sample)) for sample in samples)
    mean_square = sum(int(sample) * int(sample) for sample in samples) / sample_count
    rms_level = math.sqrt(mean_square) if mean_square > 0 else 0.0
    peak_db = amplitude_dbfs(peak_level / 32767.0)
    rms_db = amplitude_dbfs(rms_level / 32767.0)

    gain_db = 0.0
    if peak_db < AUTO_GAIN_THRESHOLD_PEAK_DB or rms_db < AUTO_GAIN_THRESHOLD_RMS_DB:
        gain_db = min(
            MAX_AUTO_GAIN_DB,
            max(
                0.0,
                AUTO_GAIN_TARGET_PEAK_DB - peak_db,
                AUTO_GAIN_TARGET_RMS_DB - rms_db,
            ),
        )

    if gain_db > 0.1:
        gain = 10.0 ** (gain_db / 20.0)
        boosted_samples = array(
            "h",
            [
                max(-32768, min(32767, int(round(int(sample) * gain))))
                for sample in samples
            ],
        )
        if os.sys.byteorder != "little":
            boosted_samples.byteswap()
        with wave.open(str(wav_path), "wb") as handle:
            handle.setparams(params)
            handle.writeframes(boosted_samples.tobytes())

    return {
        "sampleCount": sample_count,
        "inputPeakDb": round(peak_db, 2),
        "inputRmsDb": round(rms_db, 2),
        "appliedGainDb": round(gain_db, 2),
    }


def normalize_audio(raw_path: Path, wav_path: Path) -> dict[str, float | int]:
    decode_audio_to_wav(raw_path, wav_path)
    return analyze_and_gain_wav(wav_path)


def cache_key(model_name: str, model_dir: str, device: str, compute_type: str):
    return (model_name.strip(), model_dir.strip(), device.strip(), compute_type.strip())


def runtime_cache_key(runtime: dict):
    return cache_key(
        str(runtime.get("model") or "").strip(),
        str(runtime.get("modelDir") or "").strip(),
        str(runtime.get("device") or "").strip(),
        str(runtime.get("computeType") or "").strip(),
    )


def runtime_snapshot():
    with STATE_LOCK:
        return dict(ACTIVE_RUNTIME) if ACTIVE_RUNTIME else None


def set_active_runtime(runtime: dict | None) -> None:
    global ACTIVE_RUNTIME
    with STATE_LOCK:
        ACTIVE_RUNTIME = dict(runtime) if runtime else None


def discard_runtime(runtime: dict) -> None:
    MODEL_CACHE.pop(runtime_cache_key(runtime), None)
    snapshot = runtime_snapshot()
    if snapshot and runtime_cache_key(snapshot) == runtime_cache_key(runtime):
        set_active_runtime(None)


def clear_model_cache(retain_key=None) -> None:
    keys = list(MODEL_CACHE.keys())
    for key in keys:
        if retain_key is not None and key == retain_key:
            continue
        MODEL_CACHE.pop(key, None)
    gc.collect()


def resolve_runtime_command(command: dict) -> dict:
    snapshot = runtime_snapshot() or {}
    command = command if isinstance(command, dict) else {}

    requested_device = str(command.get("device") or "").strip()
    requested_compute_type = str(command.get("computeType") or "").strip()

    if not requested_compute_type and requested_device:
      requested_compute_type = "auto"
    elif not requested_compute_type:
      requested_compute_type = str(snapshot.get("computeType") or "auto").strip() or "auto"

    return {
        "model": str(command.get("model") or snapshot.get("model") or "base.en").strip() or "base.en",
        "modelDir": str(command.get("modelDir") or snapshot.get("modelDir") or "").strip(),
        "device": requested_device or str(snapshot.get("device") or "auto").strip() or "auto",
        "computeType": requested_compute_type,
        "initialPrompt": str(command.get("initialPrompt") or "").strip(),
    }


def resolved_runtime_cache_key(command: dict):
    resolved = resolve_runtime_command(command)
    selected_device = normalize_device(str(resolved.get("device") or "auto").strip() or "auto")
    selected_compute_type = normalize_compute_type(
        str(resolved.get("computeType") or "auto").strip() or "auto",
        selected_device,
    )
    return cache_key(
        str(resolved.get("model") or "base.en").strip() or "base.en",
        str(resolved.get("modelDir") or "").strip(),
        selected_device,
        selected_compute_type,
    )


def load_model(model_name: str, model_dir: str, requested_device: str, requested_compute_type: str):
    ensure_whisper_imported()

    selected_device = normalize_device(requested_device)
    selected_compute_type = normalize_compute_type(requested_compute_type, selected_device)
    attempts = [(selected_device, selected_compute_type)]
    fallback_allowed = allow_cpu_fallback(requested_device)
    if selected_device != "cpu" and fallback_allowed:
        attempts.append(("cpu", "int8"))

    last_error = None
    for attempt_device, attempt_compute_type in attempts:
        key = cache_key(model_name, model_dir, attempt_device, attempt_compute_type)
        if key in MODEL_CACHE:
            runtime = {
                "model": model_name,
                "modelDir": model_dir,
                "device": attempt_device,
                "computeType": attempt_compute_type,
                "cudaDeviceCount": cuda_device_count(),
                "warmed": True,
            }
            return MODEL_CACHE[key], runtime

        model_kwargs = {
            "device": attempt_device,
            "compute_type": attempt_compute_type,
        }
        if model_dir:
            model_kwargs["download_root"] = model_dir

        try:
            model = WhisperModel(model_name, **model_kwargs)
        except Exception as error:  # pragma: no cover - native runtime surface
            last_error = error
            if fallback_allowed and attempt_device != "cpu" and cuda_runtime_unavailable(error_text(error)):
                continue
            raise

        MODEL_CACHE[key] = model
        runtime = {
            "model": model_name,
            "modelDir": model_dir,
            "device": attempt_device,
            "computeType": attempt_compute_type,
            "cudaDeviceCount": cuda_device_count(),
            "warmed": True,
        }
        return model, runtime

    raise RuntimeError(error_text(last_error) or "Failed to load the faster-whisper model")


def clear_vad_cache() -> None:
    """Clear the cached Silero VAD ONNX session.

    faster-whisper caches the VAD model via @functools.lru_cache on
    get_vad_model().  The underlying ONNX Runtime InferenceSession
    corrupts its internal thread-pool / arena state after repeated
    inferences on Windows, causing subsequent model.transcribe() calls
    to hang.  Clearing the cache forces a fresh session (~50-100 ms).
    """
    try:
        from faster_whisper.vad import get_vad_model
        get_vad_model.cache_clear()
    except Exception:
        pass


def run_transcribe(model, input_path: str, vad_filter: bool, initial_prompt: str = ""):
    transcribe_kwargs = {
        "beam_size": 1,
        "best_of": 1,
        "temperature": 0.0,
        "vad_filter": vad_filter,
        "condition_on_previous_text": False,
    }
    normalized_prompt = str(initial_prompt or "").strip()
    if normalized_prompt:
        transcribe_kwargs["initial_prompt"] = normalized_prompt
    segments, info = model.transcribe(
        input_path,
        **transcribe_kwargs,
    )
    # Fully consume the generator to release internal ctranslate2 resources.
    # Lazy iteration can leave the model in a busy state, blocking subsequent calls.
    segment_list = list(segments)
    del segments
    transcript = " ".join(segment.text.strip() for segment in segment_list if segment.text.strip()).strip()
    language = (getattr(info, "language", None) or "en").strip() or "en"
    del segment_list
    return transcript, language


def perform_transcribe(model, input_path: str, initial_prompt: str = ""):
    # Press-to-talk dictation is sensitive to clipped starts and ends. Running
    # faster-whisper with VAD enabled as the primary pass can return a non-empty
    # transcript while still trimming quiet edge words, so prefer the full-audio
    # pass here. The VAD cache is still cleared to keep Windows runtime behavior
    # stable even when the model internals touch the VAD module.
    transcript, language = run_transcribe(model, input_path, False, initial_prompt)
    clear_vad_cache()
    gc.collect()
    return transcript, language


def transcribe_with_runtime(model_name: str, model_dir: str, requested_device: str, requested_compute_type: str, input_path: str, initial_prompt: str = ""):
    model, runtime = load_model(model_name, model_dir, requested_device, requested_compute_type)
    fallback_allowed = allow_cpu_fallback(requested_device)
    try:
        transcript, language = perform_transcribe(model, input_path, initial_prompt)
        return runtime, transcript, language
    except Exception as error:
        if fallback_allowed and runtime.get("device") != "cpu" and cuda_runtime_unavailable(error_text(error)):
            discard_runtime(runtime)
            fallback_model, fallback_runtime = load_model(model_name, model_dir, "cpu", "int8")
            transcript, language = perform_transcribe(fallback_model, input_path, initial_prompt)
            return fallback_runtime, transcript, language
        raise


def write_silent_wav(file_path: str, duration_ms: int = 120) -> None:
    sample_rate = 16000
    sample_count = max(1, int(sample_rate * max(1, duration_ms) / 1000))
    with wave.open(file_path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * sample_count)


def runtime_payload(*, ok: bool = True, error: str = "") -> dict[str, str | bool]:
    snapshot = runtime_snapshot()
    payload: dict[str, str | bool] = {
        "ok": ok,
        "ready": bool(snapshot),
        "busy": TRANSCRIBE_LOCK.locked(),
        "cudaDeviceCount": cuda_device_count(),
    }
    if snapshot:
        payload.update(snapshot)
    if error:
        payload["error"] = error
    return payload


def warm_runtime(command: dict) -> dict:
    resolved = resolve_runtime_command(command)
    model_name = str(resolved.get("model") or "base.en").strip() or "base.en"
    model_dir = str(resolved.get("modelDir") or "").strip()
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            temp_path = handle.name
        write_silent_wav(temp_path)
        with TRANSCRIBE_LOCK:
            runtime, _transcript, _language = transcribe_with_runtime(
                model_name,
                model_dir,
                str(resolved.get("device") or "auto").strip() or "auto",
                str(resolved.get("computeType") or "auto").strip() or "auto",
                temp_path,
                str(resolved.get("initialPrompt") or "").strip(),
            )
        set_active_runtime(runtime)
        return {
            **runtime_payload(),
            "cacheSize": len(MODEL_CACHE),
        }
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass


def transcribe_audio(command: dict, audio_bytes: bytes, content_type: str) -> dict:
    if not audio_bytes:
        raise ValueError("Audio body is empty.")

    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="dictray-stt-") as temp_dir:
        temp_path = Path(temp_dir)
        raw_path = temp_path / f"input{input_extension(content_type)}"
        wav_path = temp_path / "normalized.wav"
        raw_path.write_bytes(audio_bytes)

        normalize_started = time.perf_counter()
        audio_stats = normalize_audio(raw_path, wav_path)
        normalize_ms = round((time.perf_counter() - normalize_started) * 1000)

        with TRANSCRIBE_LOCK:
            transcribe_started = time.perf_counter()
            runtime, transcript, language = transcribe_with_runtime(
                str(command.get("model") or "base.en").strip() or "base.en",
                str(command.get("modelDir") or "").strip(),
                str(command.get("device") or "auto").strip() or "auto",
                str(command.get("computeType") or "auto").strip() or "auto",
                str(wav_path),
                str(command.get("initialPrompt") or "").strip(),
            )
            transcribe_ms = round((time.perf_counter() - transcribe_started) * 1000)

    set_active_runtime(runtime)
    return {
        "ok": True,
        **runtime,
        "transcript": transcript,
        "language": language,
        "audioStats": audio_stats,
        "timingsMs": {
            "normalize": normalize_ms,
            "transcribe": transcribe_ms,
            "total": round((time.perf_counter() - started) * 1000),
        },
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "DicTraySttDaemon/1.0"

    def log_message(self, format: str, *args) -> None:  # pragma: no cover - silence stdlib server logging
        return

    def send_json(self, status: int, payload: dict) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # pragma: no cover - simple stdlib entrypoint
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            if IMPORT_ERROR:
                self.send_json(503, runtime_payload(ok=False, error=IMPORT_ERROR))
                return
            self.send_json(200, runtime_payload())
            return
        if parsed.path == "/runtime":
            if IMPORT_ERROR:
                self.send_json(503, runtime_payload(ok=False, error=IMPORT_ERROR))
                return
            payload = runtime_payload()
            payload["availableDevices"] = ["cpu", "cuda"] if cuda_device_count() > 0 else ["cpu"]
            self.send_json(200, payload)
            return
        self.send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:  # pragma: no cover - simple stdlib entrypoint
        parsed = urlparse(self.path)
        content_length = max(0, int(self.headers.get("Content-Length", "0") or 0))
        raw_body = self.rfile.read(content_length) if content_length > 0 else b""

        try:
            if IMPORT_ERROR:
                raise RuntimeError(IMPORT_ERROR)

            if parsed.path == "/warm":
                payload = warm_runtime(read_json_bytes(raw_body))
                self.send_json(200, payload)
                return

            if parsed.path == "/transcribe":
                initial_prompt = (
                    decode_header_base64(self.headers.get("X-Stt-Initial-Prompt-B64", ""))
                    or self.headers.get("X-Stt-Initial-Prompt", "")
                )
                payload = {
                    "model": self.headers.get("X-Stt-Model", "base.en"),
                    "modelDir": self.headers.get("X-Stt-Model-Dir", ""),
                    "device": self.headers.get("X-Stt-Device", "auto"),
                    "computeType": self.headers.get("X-Stt-Compute-Type", "auto"),
                    "initialPrompt": initial_prompt,
                }
                result = transcribe_audio(payload, raw_body, self.headers.get("Content-Type", "application/octet-stream"))
                self.send_json(200, result)
                return

            if parsed.path == "/shutdown":
                self.send_json(200, {"ok": True, "shutdown": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return

            self.send_json(404, {"ok": False, "error": "Not found"})
        except Exception as error:
            self.send_json(503, runtime_payload(ok=False, error=error_text(error) or "Unknown daemon error"))

    def do_PUT(self) -> None:  # pragma: no cover - simple stdlib entrypoint
        parsed = urlparse(self.path)
        content_length = max(0, int(self.headers.get("Content-Length", "0") or 0))
        raw_body = self.rfile.read(content_length) if content_length > 0 else b""

        try:
            if IMPORT_ERROR:
                raise RuntimeError(IMPORT_ERROR)

            if parsed.path == "/runtime":
                command = read_json_bytes(raw_body)
                current = runtime_snapshot()
                next_key = resolved_runtime_cache_key(command)
                current_key = runtime_cache_key(current) if current else None
                if current_key != next_key:
                    clear_model_cache()
                    set_active_runtime(None)
                # Apply the requested runtime settings by warming with the new config
                payload = warm_runtime(command)
                payload["availableDevices"] = ["cpu", "cuda"] if cuda_device_count() > 0 else ["cpu"]
                self.send_json(200, payload)
                return

            self.send_json(404, {"ok": False, "error": "Not found"})
        except Exception as error:
            self.send_json(503, runtime_payload(ok=False, error=error_text(error) or "Unknown daemon error"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default="4591")
    args = parser.parse_args()

    server = HTTPServer((args.host, int(args.port)), Handler)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:  # pragma: no cover - manual shutdown path
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
