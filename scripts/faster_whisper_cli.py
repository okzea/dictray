#!/usr/bin/env python3

import argparse
import json
import sys

try:
    import ctranslate2
except Exception:  # pragma: no cover - optional import surface
    ctranslate2 = None

from faster_whisper import WhisperModel


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper.")
    parser.add_argument("input_path", nargs="?", help="Path to the input audio file.")
    parser.add_argument("--health", action="store_true", help="Print a lightweight health payload and exit.")
    parser.add_argument("--model", default="base.en", help="Whisper model name.")
    parser.add_argument("--device", default="auto", help="auto, cpu, or cuda")
    parser.add_argument("--compute-type", default="auto", help="auto, int8, float16, float32, etc.")
    return parser.parse_args()


def print_json(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> int:
    args = parse_args()
    device = normalize_device(args.device)
    compute_type = normalize_compute_type(args.compute_type, device)
    payload = {
        "ok": True,
        "model": args.model,
        "device": device,
        "computeType": compute_type,
        "cudaDeviceCount": cuda_device_count(),
    }

    if args.health:
        print_json(payload)
        return 0

    if not args.input_path:
        raise ValueError("input_path is required unless --health is used")

    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        args.input_path,
        beam_size=1,
        best_of=1,
        temperature=0.0,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    language = (getattr(info, "language", None) or "en").strip() or "en"
    print_json({
        **payload,
        "transcript": transcript,
        "language": language,
    })
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # pragma: no cover - CLI error reporting
        sys.stderr.write(f"{error}\n")
        raise SystemExit(1)
