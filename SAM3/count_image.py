"""Count an image using the deployed Modal app; no local GPU is needed."""

import argparse
import json
import sys
from pathlib import Path

APP_NAME = "epikd-sam3-counter"
MAX_IMAGE_BYTES = 12 * 1024 * 1024


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--image", type=Path)
    inputs.add_argument("--call-id", help="Retrieve an already submitted job without resubmitting")
    parser.add_argument("--wait-seconds", type=int, default=45, help="Wait this long, then print how to retrieve the result")
    parser.add_argument("--prompt", default="car", help="Concept to segment, e.g. car or mosquito")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "results")
    parser.add_argument("--env", default="main", help="Modal environment")
    args = parser.parse_args(argv)
    if not 0 <= args.wait_seconds <= 600:
        parser.error("--wait-seconds must be between 0 and 600")
    if args.image is not None:
        if not args.image.is_file():
            parser.error(f"Image does not exist: {args.image}")
        if not 0 < args.threshold < 1:
            parser.error("--threshold must be strictly between 0 and 1")
        if not 1 <= len(args.prompt.strip()) <= 120:
            parser.error("--prompt must contain 1-120 characters")
        if args.image.stat().st_size > MAX_IMAGE_BYTES:
            parser.error("Image exceeds the 12 MiB upload limit")

    import modal

    if args.call_id:
        call_id = args.call_id
        call = modal.FunctionCall.from_id(call_id)
    else:
        counter = modal.Cls.from_name(APP_NAME, "ObjectCounter", environment_name=args.env)()
        print("Submitting image to Modal...", flush=True)
        call = counter.count.spawn(args.image.read_bytes(), args.prompt, args.threshold)
        call_id = call.object_id
    print(f"Job: {call_id}", flush=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    pending_file = args.output_dir / f"pending_{call_id}.json"
    pending_file.write_text(json.dumps({"call_id": call_id, "app": APP_NAME}), encoding="utf-8")
    try:
        result = call.get(timeout=args.wait_seconds)
    except TimeoutError:
        print("Still queued or running. Retrieve THIS job rather than submitting another image:", flush=True)
        print(f'python SAM3/count_image.py --call-id {call_id}', flush=True)
        return 0
    report = result["report"]
    directory = args.output_dir / report["run_id"]
    directory.mkdir(parents=True, exist_ok=False)
    report_file = directory / "result.json"
    annotated_file = directory / "annotated.png"
    report_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
    annotated_file.write_bytes(result["annotated_png"])
    pending_file.unlink(missing_ok=True)
    print(json.dumps({
        "prompt": report["prompt"],
        "count": report["count"],
        "threshold": report["threshold"],
        "gpu": report["gpu"],
        "inference_seconds": report["inference_seconds"],
        "result_json": str(report_file.resolve()),
        "annotated_image": str(annotated_file.resolve()),
        "modal_storage": f"sam3-outputs/{report['storage_directory']}",
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
