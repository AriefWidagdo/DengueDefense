"""SAM3 object counting on Modal, reusing the existing sam3-checkpoint volume.

Deploy: python -m modal deploy SAM3/modal_counter.py
Test:   python SAM3/count_image.py --image SAM3/examples/parking.jpg --prompt car

The HTTP endpoint requires Modal proxy authentication. The local client uses
normal Modal workspace credentials, so no public unauthenticated GPU is exposed.
"""

import modal

APP_NAME = "epikd-sam3-counter"
SAM3_COMMIT = "f1647e8d0c1d280991f4d1b7d974c2704537fe66"
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000

app = modal.App(APP_NAME)
checkpoints = modal.Volume.from_name("sam3-checkpoint", create_if_missing=False)
outputs = modal.Volume.from_name("sam3-outputs", create_if_missing=False)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install("setuptools==80.9.0")
    .pip_install(
        "torch==2.10.0", "torchvision==0.25.0",
        index_url="https://download.pytorch.org/whl/cu128",
    )
    .pip_install(
        f"sam3 @ git+https://github.com/facebookresearch/sam3.git@{SAM3_COMMIT}",
        "Pillow==12.0.0", "einops", "decord==0.6.0", "pycocotools",
        "opencv-python-headless==4.11.0.86", "scipy", "psutil", "fastapi",
    )
    .run_commands(
        "python -c 'from sam3.model_builder import build_sam3_image_model; "
        "from sam3.model.sam3_image_processor import Sam3Processor; "
        "print(\"SAM3 imports OK\")'"
    )
)


@app.cls(
    image=image,
    gpu=["L4", "A10G"],
    cpu=4,
    memory=16384,
    volumes={
        "/checkpoints": checkpoints.with_mount_options(read_only=True),
        "/outputs": outputs,
    },
    min_containers=0,
    max_containers=1,
    scaledown_window=60,
    timeout=300,
    startup_timeout=600,
)
class ObjectCounter:
    @modal.enter()
    def load_model(self):
        import time
        from pathlib import Path

        import torch
        from sam3.model_builder import build_sam3_image_model
        from sam3.model.sam3_image_processor import Sam3Processor

        checkpoint = Path("/checkpoints/sam3.pt")
        if not checkpoint.is_file():
            raise FileNotFoundError(f"Existing checkpoint not found: {checkpoint}")
        started = time.perf_counter()
        self.model = build_sam3_image_model(
            checkpoint_path=str(checkpoint), load_from_HF=False,
            device="cuda", eval_mode=True, compile=False,
        )
        self.processor = Sam3Processor(self.model, device="cuda")
        self.device_name = torch.cuda.get_device_name(0)
        self.load_seconds = round(time.perf_counter() - started, 3)
        print(f"Loaded SAM3 on {self.device_name} in {self.load_seconds}s", flush=True)

    @modal.method()
    def count(self, image_bytes: bytes, prompt: str = "car", threshold: float = 0.5):
        """Return a JSON-serializable report and annotated PNG bytes.

        Count means SAM3 instances above the supplied confidence threshold in
        ONE image. It is not ground truth or a unique count across photographs.
        No extra NMS is silently added to the model's instance predictions.
        """
        import hashlib
        import io
        import json
        import math
        import time
        import uuid
        from datetime import datetime, timezone
        from pathlib import Path

        import numpy as np
        import torch
        from PIL import Image, ImageDraw, ImageFont, ImageOps

        if not isinstance(image_bytes, bytes) or not image_bytes:
            raise ValueError("image_bytes must contain a nonempty image")
        if len(image_bytes) > MAX_IMAGE_BYTES:
            raise ValueError("Image exceeds the 12 MiB upload limit")
        if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 120:
            raise ValueError("Prompt must contain 1-120 characters")
        if isinstance(threshold, bool) or not isinstance(threshold, (float, int)):
            raise ValueError("Threshold must be a number between 0 and 1")
        if not math.isfinite(threshold) or not 0 < threshold < 1:
            raise ValueError("Threshold must be strictly between 0 and 1")
        prompt = prompt.strip()
        with Image.open(io.BytesIO(image_bytes)) as source:
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise ValueError("Image exceeds the 16 megapixel limit")
            original = ImageOps.exif_transpose(source).convert("RGB")
            original.load()

        self.processor.set_confidence_threshold(float(threshold))
        torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            state = self.processor.set_image(original)
            prediction = self.processor.set_text_prompt(prompt=prompt, state=state)
        torch.cuda.synchronize()
        inference_seconds = round(time.perf_counter() - started, 3)
        scores = prediction["scores"].detach().float().cpu().numpy()
        boxes = prediction["boxes"].detach().float().cpu().numpy()
        masks = prediction["masks"].detach().cpu().numpy()[:, 0].astype(bool)
        order = np.argsort(-scores, kind="stable")

        overlay = np.asarray(original).copy()
        colors = [(34, 197, 94), (56, 189, 248), (251, 191, 36), (244, 114, 182)]
        detections = []
        for instance_id, index in enumerate(order, start=1):
            mask = masks[index]
            color = np.asarray(colors[(instance_id - 1) % len(colors)])
            overlay[mask] = (0.6 * overlay[mask] + 0.4 * color).astype(np.uint8)
            detections.append({
                "id": instance_id,
                "score": round(float(scores[index]), 6),
                "box_xyxy": [round(float(v), 2) for v in boxes[index]],
                "mask_area_pixels": int(mask.sum()),
            })
        annotated = Image.fromarray(overlay)
        draw = ImageDraw.Draw(annotated)
        font = ImageFont.load_default(size=max(14, min(original.size) // 45))
        for detection in detections:
            x1, y1, x2, y2 = detection["box_xyxy"]
            color = colors[(detection["id"] - 1) % len(colors)]
            draw.rectangle((x1, y1, x2, y2), outline=color, width=3)
            label = f"{detection['id']}: {detection['score']:.2f}"
            label_xy = (max(0, x1), max(32, y1 - 20))
            draw.text(label_xy, label, font=font, fill="white", stroke_width=2, stroke_fill="black")
        draw.rectangle((0, 0, annotated.width, 31), fill="black")
        draw.text((8, 5), f"SAM3 | {prompt} | count: {len(detections)} | threshold: {threshold:g}", font=font, fill="white")
        buffer = io.BytesIO()
        annotated.save(buffer, format="PNG")
        annotated_bytes = buffer.getvalue()

        timestamp = datetime.now(timezone.utc)
        run_id = timestamp.strftime("%Y%m%dT%H%M%SZ") + "_" + uuid.uuid4().hex[:8]
        relative_dir = f"counter-tests/{run_id}"
        directory = Path("/outputs") / relative_dir
        directory.mkdir(parents=True, exist_ok=False)
        report = {
            "run_id": run_id,
            "created_at": timestamp.isoformat(),
            "prompt": prompt,
            "threshold": float(threshold),
            "count": len(detections),
            "image_width": original.width,
            "image_height": original.height,
            "input_sha256": hashlib.sha256(image_bytes).hexdigest(),
            "model": "facebook/sam3 (original checkpoint)",
            "sam3_code_commit": SAM3_COMMIT,
            "gpu": self.device_name,
            "model_load_seconds": self.load_seconds,
            "inference_seconds": inference_seconds,
            "detections": detections,
            "storage_volume": "sam3-outputs",
            "storage_directory": relative_dir,
            "count_definition": "Predicted instances in one image; not independently verified ground truth.",
        }
        original.save(directory / "input.png")
        (directory / "annotated.png").write_bytes(annotated_bytes)
        (directory / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        outputs.commit()
        return {"report": report, "annotated_png": annotated_bytes}

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def count_http(self, body: dict):
        """JSON: {image_base64: ..., prompt: 'car', threshold: 0.5}."""
        import base64
        import binascii
        from fastapi import HTTPException

        encoded = body.get("image_base64")
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
            raise HTTPException(status_code=400, detail="image_base64 is missing or too large")
        try:
            image_bytes = base64.b64decode(encoded, validate=True)
            result = self.count.local(
                image_bytes, body.get("prompt", "car"), body.get("threshold", 0.5)
            )
        except (ValueError, OSError, binascii.Error) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {
            **result["report"],
            "annotated_png_base64": base64.b64encode(result["annotated_png"]).decode("ascii"),
        }
