import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import ctranslate2
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from faster_whisper import WhisperModel

APP = FastAPI(title="jarvis-speech-stt")
app = APP

FFMPEG_BIN = os.getenv("STT_FFMPEG_BIN", "ffmpeg")
DEFAULT_MODEL_NAME = os.getenv("STT_MODEL", "base.en")
DEFAULT_DEVICE = os.getenv("STT_DEVICE", "cpu")
DEFAULT_COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "").strip().lower()
DEFAULT_AVAILABLE_DEVICES = os.getenv("STT_AVAILABLE_DEVICES", "auto")

MODEL_LOCK = threading.Lock()
MODEL = None


class RuntimeRequest(BaseModel):
    device: str | None = None
    computeType: str | None = None
    model: str | None = None


def normalize_available_devices(raw: str) -> list[str]:
    values: list[str] = []
    for item in (raw or "").split(","):
        value = item.strip().lower()
        if value == "gpu":
            value = "cuda"
        if value in {"cpu", "cuda", "auto"} and value not in values:
            values.append(value)
    return values or ["auto"]


def cuda_device_count() -> int:
    try:
        return max(0, int(ctranslate2.get_cuda_device_count()))
    except Exception:
        return 0


def default_compute_type_for(device: str) -> str:
    return "float16" if device == "cuda" else "int8"


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


def runtime_snapshot() -> dict[str, str]:
    with MODEL_LOCK:
        return dict(RUNTIME)


def available_devices() -> list[str]:
    values = normalize_available_devices(DEFAULT_AVAILABLE_DEVICES)
    if "auto" not in values:
        return [value for value in values if value in {"cpu", "cuda"}] or ["cpu"]

    available = ["cpu"]
    if cuda_device_count() > 0:
        available.append("cuda")
    return available


def normalize_runtime_device(device: str) -> str:
    value = (device or "cpu").strip().lower()
    if value == "gpu":
        value = "cuda"
    if value not in {"cpu", "cuda"}:
        return "cpu"
    if value == "cuda" and "cuda" not in available_devices():
        return "cpu"
    return value


def ensure_model_locked():
    global MODEL
    if MODEL is None:
        MODEL = WhisperModel(RUNTIME["model"], device=RUNTIME["device"], compute_type=RUNTIME["compute_type"])
    return MODEL


def runtime_payload(*, ok: bool = True, error: str = "") -> dict[str, str | bool]:
    snapshot = runtime_snapshot()
    payload: dict[str, str | bool] = {
        "ok": ok,
        "model": snapshot["model"],
        "device": snapshot["device"],
        "computeType": snapshot["compute_type"],
        "availableDevices": available_devices(),
        "cudaDeviceCount": cuda_device_count(),
    }
    if error:
        payload["error"] = error
    return payload


def normalize_runtime_update(payload: RuntimeRequest) -> dict[str, str]:
    current = runtime_snapshot()
    allowed_devices = available_devices()
    device = (payload.device or current["device"]).strip().lower()
    if device == "gpu":
        device = "cuda"
    if device not in {"cpu", "cuda"}:
        raise ValueError("device must be 'cpu' or 'cuda'")
    if device not in allowed_devices:
        if device == "cuda":
            raise ValueError("GPU STT is not available in this Docker STT runtime. The current image/runtime is CPU-only.")
        raise ValueError(f"device '{device}' is not available in this Docker STT runtime")

    compute_type = (payload.computeType or "").strip().lower()
    if not compute_type:
        compute_type = default_compute_type_for(device)

    model = (payload.model or current["model"]).strip() or current["model"]
    return {
        "model": model,
        "device": device,
        "compute_type": compute_type,
    }


RUNTIME = {
    "model": DEFAULT_MODEL_NAME,
    "device": normalize_runtime_device(DEFAULT_DEVICE),
    "compute_type": DEFAULT_COMPUTE_TYPE or default_compute_type_for(normalize_runtime_device(DEFAULT_DEVICE)),
}


def swap_runtime(next_runtime: dict[str, str]) -> None:
    global MODEL
    next_model = WhisperModel(
        next_runtime["model"],
        device=next_runtime["device"],
        compute_type=next_runtime["compute_type"],
    )
    with MODEL_LOCK:
        MODEL = next_model
        RUNTIME.update(next_runtime)


def normalize_audio(raw_path: Path, wav_path: Path) -> None:
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


def transcribe_wav(wav_path: Path) -> tuple[str, str]:
    with MODEL_LOCK:
        segments, info = ensure_model_locked().transcribe(
            str(wav_path),
            beam_size=1,
            best_of=1,
            temperature=0.0,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
        language = (getattr(info, "language", None) or "en").strip() or "en"
        return transcript, language


@APP.get("/health")
def health():
    try:
        with MODEL_LOCK:
            ensure_model_locked()
        subprocess.run([FFMPEG_BIN, "-version"], check=True, capture_output=True, text=True)
        return runtime_payload()
    except Exception as error:  # pragma: no cover - runtime health fallback
        return JSONResponse(status_code=503, content=runtime_payload(ok=False, error=str(error)))


@APP.get("/runtime")
def runtime():
    return runtime_payload()


@APP.put("/runtime")
def update_runtime(payload: RuntimeRequest):
    try:
        next_runtime = normalize_runtime_update(payload)
        swap_runtime(next_runtime)
        return runtime_payload()
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:  # pragma: no cover - runtime health fallback
        return JSONResponse(status_code=400, content=runtime_payload(ok=False, error=str(error)))


@APP.post("/transcribe")
async def transcribe(request: Request):
    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio body is empty.")

    content_type = request.headers.get("content-type", "application/octet-stream")
    started = time.perf_counter()

    with tempfile.TemporaryDirectory(prefix="jarvis-stt-") as temp_dir:
        temp_path = Path(temp_dir)
        raw_path = temp_path / f"input{input_extension(content_type)}"
        wav_path = temp_path / "normalized.wav"
        raw_path.write_bytes(audio_bytes)

        normalize_started = time.perf_counter()
        normalize_audio(raw_path, wav_path)
        normalize_ms = round((time.perf_counter() - normalize_started) * 1000)

        transcribe_started = time.perf_counter()
        transcript, language = transcribe_wav(wav_path)
        transcribe_ms = round((time.perf_counter() - transcribe_started) * 1000)

    return {
        "transcript": transcript,
        "language": language,
        "timingsMs": {
            "normalize": normalize_ms,
            "transcribe": transcribe_ms,
            "total": round((time.perf_counter() - started) * 1000),
        },
    }
