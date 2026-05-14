#!/usr/bin/env python3

import json
import os
import sys
import tempfile
import wave

try:
    import ctranslate2
except Exception:  # pragma: no cover - optional import surface
    ctranslate2 = None

try:
    from faster_whisper import WhisperModel
except ModuleNotFoundError as error:  # pragma: no cover - optional import surface
    missing = getattr(error, "name", "") or "faster_whisper"
    WhisperModel = None
    IMPORT_ERROR = f"Missing Python dependency '{missing}'. Install faster-whisper in the Python environment used by DicTray."
except Exception as error:  # pragma: no cover - optional import surface
    WhisperModel = None
    IMPORT_ERROR = str(error)
else:
    IMPORT_ERROR = ""

MODEL_CACHE = {}
ACTIVE_RUNTIME = None


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


def print_json(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def error_text(error: Exception) -> str:
    return str(error or "").strip()


def cuda_runtime_unavailable(message: str) -> bool:
    return bool(message) and (
        "cublas" in message.lower()
        or "cudnn" in message.lower()
        or ("cuda" in message.lower() and ("not found" in message.lower() or "cannot be loaded" in message.lower() or "load failed" in message.lower()))
    )


def ensure_whisper_imported() -> None:
    if WhisperModel is None:
        raise RuntimeError(IMPORT_ERROR or "faster-whisper is unavailable")


def cache_key(model_name: str, model_dir: str, device: str, compute_type: str):
    return (model_name.strip(), model_dir.strip(), device.strip(), compute_type.strip())


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


def runtime_cache_key(runtime: dict):
    return cache_key(
        str(runtime.get("model") or "").strip(),
        str(runtime.get("modelDir") or "").strip(),
        str(runtime.get("device") or "").strip(),
        str(runtime.get("computeType") or "").strip(),
    )


def discard_runtime(runtime: dict) -> None:
    global ACTIVE_RUNTIME
    if not runtime:
        return

    MODEL_CACHE.pop(runtime_cache_key(runtime), None)
    if ACTIVE_RUNTIME and runtime_cache_key(ACTIVE_RUNTIME) == runtime_cache_key(runtime):
        ACTIVE_RUNTIME = None


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
    segment_list = list(segments)
    transcript = " ".join(segment.text.strip() for segment in segment_list if segment.text.strip()).strip()
    language = (getattr(info, "language", None) or "en").strip() or "en"
    return transcript, language


def perform_transcribe(model, input_path: str, initial_prompt: str = ""):
    # Match the daemon path: prefer the full-audio pass so quiet leading and
    # trailing words are not discarded by the VAD gate.
    transcript, language = run_transcribe(model, input_path, False, initial_prompt)
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


def build_runtime_payload(model_name: str, model_dir: str, requested_device: str, requested_compute_type: str):
    global ACTIVE_RUNTIME
    if ACTIVE_RUNTIME and ACTIVE_RUNTIME.get("model") == model_name and ACTIVE_RUNTIME.get("modelDir") == model_dir:
        return {
            "ok": True,
            **ACTIVE_RUNTIME,
        }

    resolved_device = normalize_device(requested_device)
    resolved_compute_type = normalize_compute_type(requested_compute_type, resolved_device)
    return {
        "ok": True,
        "model": model_name,
        "modelDir": model_dir,
        "device": resolved_device,
        "computeType": resolved_compute_type,
        "cudaDeviceCount": cuda_device_count(),
        "warmed": False,
    }


def handle_health(command: dict) -> dict:
    ensure_whisper_imported()
    return build_runtime_payload(
        str(command.get("model") or "base.en").strip() or "base.en",
        str(command.get("modelDir") or "").strip(),
        str(command.get("device") or "auto").strip() or "auto",
        str(command.get("computeType") or "auto").strip() or "auto",
    )


def handle_warm(command: dict) -> dict:
    global ACTIVE_RUNTIME
    model_name = str(command.get("model") or "base.en").strip() or "base.en"
    model_dir = str(command.get("modelDir") or "").strip()
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            temp_path = handle.name
        write_silent_wav(temp_path)
        runtime, _transcript, _language = transcribe_with_runtime(
            model_name,
            model_dir,
            str(command.get("device") or "auto").strip() or "auto",
            str(command.get("computeType") or "auto").strip() or "auto",
            temp_path,
            str(command.get("initialPrompt") or "").strip(),
        )
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass
    ACTIVE_RUNTIME = runtime
    return {
        "ok": True,
        **runtime,
        "cacheSize": len(MODEL_CACHE),
    }


def handle_transcribe(command: dict) -> dict:
    global ACTIVE_RUNTIME
    input_path = str(command.get("inputPath") or "").strip()
    if not input_path:
        raise ValueError("inputPath is required")

    model_name = str(command.get("model") or "base.en").strip() or "base.en"
    model_dir = str(command.get("modelDir") or "").strip()
    runtime, transcript, language = transcribe_with_runtime(
        model_name,
        model_dir,
        str(command.get("device") or "auto").strip() or "auto",
        str(command.get("computeType") or "auto").strip() or "auto",
        input_path,
        str(command.get("initialPrompt") or "").strip(),
    )
    ACTIVE_RUNTIME = runtime
    return {
        "ok": True,
        **runtime,
        "transcript": transcript,
        "language": language,
    }


def handle_command(command: dict) -> dict:
    action = str(command.get("action") or "").strip().lower()
    if action == "health":
        return handle_health(command)
    if action == "warm":
        return handle_warm(command)
    if action == "transcribe":
        return handle_transcribe(command)
    if action == "shutdown":
        return {
            "ok": True,
            "shutdown": True,
        }
    raise ValueError(f"Unsupported worker action: {action or 'unknown'}")


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        command_id = None
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError("worker command must be a JSON object")
            command_id = command.get("id")
            payload = handle_command(command)
            print_json({
                "id": command_id,
                **payload,
            })
            if payload.get("shutdown"):
                return 0
        except Exception as error:  # pragma: no cover - runtime error surface
            print_json({
                "id": command_id,
                "ok": False,
                "error": error_text(error) or "Unknown worker error",
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
