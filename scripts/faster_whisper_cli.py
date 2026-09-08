#!/usr/bin/env python3

import argparse
import json
import sys

try:
    import ctranslate2
except Exception:  # pragma: no cover - optional import surface
    ctranslate2 = None


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
    parser.add_argument("--model-dir", default="", help="Optional faster-whisper download/cache directory.")
    parser.add_argument("--device", default="auto", help="auto, cpu, or cuda")
    parser.add_argument("--compute-type", default="auto", help="auto, int8, float16, float32, etc.")
    parser.add_argument("--initial-prompt", default="", help="Optional faster-whisper initial prompt for vocabulary biasing.")
    return parser.parse_args()


def print_json(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def load_whisper_model_class():
    try:
        from faster_whisper import WhisperModel
        return WhisperModel
    except ModuleNotFoundError as error:
        missing = getattr(error, "name", "") or "faster_whisper"
        raise RuntimeError(
            f"Missing Python dependency '{missing}'. Install faster-whisper in the Python environment used by DicTray."
        ) from error


def main() -> int:
    args = parse_args()
    device = normalize_device(args.device)
    compute_type = normalize_compute_type(args.compute_type, device)
    payload = {
        "ok": True,
        "model": args.model,
        "modelDir": args.model_dir,
        "device": device,
        "computeType": compute_type,
        "cudaDeviceCount": cuda_device_count(),
    }

    try:
        whisper_model_class = load_whisper_model_class()
    except Exception as error:
        if args.health:
            print_json({
                **payload,
                "ok": False,
                "error": str(error),
            })
            return 0
        raise

    if args.health:
        print_json(payload)
        return 0

    if not args.input_path:
        raise ValueError("input_path is required unless --health is used")

    model_kwargs = {
        "device": device,
        "compute_type": compute_type,
    }
    if args.model_dir:
        model_kwargs["download_root"] = args.model_dir

    model = whisper_model_class(args.model, **model_kwargs)
    def transcribe_once(vad_filter: bool) -> tuple[str, str]:
        transcribe_kwargs = {
            "beam_size": 1,
            "best_of": 1,
            "temperature": 0.0,
            "vad_filter": vad_filter,
            "condition_on_previous_text": False,
        }
        normalized_prompt = str(args.initial_prompt or "").strip()
        if normalized_prompt:
            transcribe_kwargs["initial_prompt"] = normalized_prompt
        segments, info = model.transcribe(
            args.input_path,
            **transcribe_kwargs,
        )
        segment_list = list(segments)
        transcript = " ".join(segment.text.strip() for segment in segment_list if segment.text.strip()).strip()
        language = (getattr(info, "language", None) or "en").strip() or "en"
        return transcript, language

    transcript, language = transcribe_once(False)
    print_json({
        **payload,
        "transcript": transcript,
        "language": language,
        "usedVadFallback": False,
    })
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # pragma: no cover - CLI error reporting
        sys.stderr.write(f"{error}\n")
        raise SystemExit(1)
