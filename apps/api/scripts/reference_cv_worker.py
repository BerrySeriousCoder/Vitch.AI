#!/usr/bin/env python3
"""Optional local reference-video measurement worker.

Exit 42 means OpenCV is unavailable and Tempo should use its built-in
FFmpeg/TypeScript evidence extractor. PaddleOCR is optional even when OpenCV is
present. stdout is JSON only so the Node service can treat this as an isolated
worker process.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
import sys
from typing import Any

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
except Exception:
    sys.exit(42)


def rect(x: int, y: int, width: int, height: int, frame_width: int, frame_height: int) -> dict[str, float]:
    return {
        "x": x / frame_width,
        "y": y / frame_height,
        "width": width / frame_width,
        "height": height / frame_height,
    }


def large_components(gray: Any) -> list[dict[str, float]]:
    height, width = gray.shape
    # Black gaps/plates separate the surfaces in motion-graphic grids. Morph
    # cleanup suppresses glyph strokes and codec noise without assuming 2x2.
    _, mask = cv2.threshold(gray, 24, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    regions: list[tuple[int, dict[str, float]]] = []
    for index in range(1, count):
        x, y, region_width, region_height, area = [int(value) for value in stats[index]]
        if area < width * height * 0.01:
            continue
        regions.append((area, rect(x, y, region_width, region_height, width, height)))
    regions.sort(key=lambda item: item[0], reverse=True)
    return [region for _, region in regions[:12]]


def foreground(gray: Any) -> dict[str, float] | None:
    points = cv2.findNonZero((gray > 24).astype(np.uint8))
    if points is None:
        return None
    x, y, width, height = cv2.boundingRect(points)
    return rect(x, y, width, height, gray.shape[1], gray.shape[0])


def optical_flow(previous: Any, current: Any) -> dict[str, float]:
    flow = cv2.calcOpticalFlowFarneback(previous, current, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    dx = float(np.median(flow[..., 0]))
    dy = float(np.median(flow[..., 1]))
    magnitude = float(np.mean(np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2)))
    diagonal = math.sqrt(current.shape[1] ** 2 + current.shape[0] ** 2)
    return {"dx": dx / current.shape[1], "dy": dy / current.shape[0], "magnitude": magnitude / diagonal}


def create_ocr(enabled: bool, requested_device: str) -> tuple[Any | None, str]:
    if not enabled:
        return None, "disabled"
    try:
        # Paddle emits oneDNN/model-cache progress to stdout. Keep this worker's
        # stdout JSON-only so the Node adapter can parse it reliably.
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        with contextlib.redirect_stdout(sys.stderr), contextlib.redirect_stderr(sys.stderr):
            import paddle  # type: ignore
            from paddleocr import PaddleOCR  # type: ignore
            can_use_gpu = bool(paddle.is_compiled_with_cuda())
            if requested_device == "gpu" and not can_use_gpu:
                raise RuntimeError("GPU requested but this PaddlePaddle wheel has no CUDA support")
            device = "gpu:0" if requested_device == "gpu" or (requested_device == "auto" and can_use_gpu) else "cpu"
            return PaddleOCR(
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                device=device,
            ), device
    except Exception:
        if requested_device == "gpu":
            raise
        return None, "unavailable"


def ocr_frame(engine: Any, frame: Any, time: float) -> list[dict[str, Any]]:
    if engine is None:
        return []
    try:
        with contextlib.redirect_stdout(sys.stderr), contextlib.redirect_stderr(sys.stderr):
            result = list(engine.predict(frame))
        observations: list[dict[str, Any]] = []
        for item in result:
            data = item.json if hasattr(item, "json") else item
            if isinstance(data, str):
                data = json.loads(data)
            data = data.get("res", data) if isinstance(data, dict) else {}
            texts = data.get("rec_texts", [])
            scores = data.get("rec_scores", [])
            boxes = data.get("rec_boxes", [])
            for text, score, box in zip(texts, scores, boxes):
                x1, y1, x2, y2 = [float(value) for value in box]
                observations.append({
                    "time": time,
                    "text": str(text),
                    "confidence": float(score),
                    "rect": {
                        "x": x1 / frame.shape[1],
                        "y": y1 / frame.shape[0],
                        "width": max(0.0, (x2 - x1) / frame.shape[1]),
                        "height": max(0.0, (y2 - y1) / frame.shape[0]),
                    },
                })
        return observations
    except Exception:
        return []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--fps", type=float, default=12)
    parser.add_argument("--duration", type=float, default=180)
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--device", choices=("auto", "cpu", "gpu"), default="auto")
    args = parser.parse_args()

    capture = cv2.VideoCapture(args.video)
    if not capture.isOpened():
        raise RuntimeError("OpenCV could not open reference video")
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 30)
    frame_count = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    source_duration = frame_count / source_fps if frame_count > 0 else args.duration
    duration = min(max(0.1, args.duration), source_duration, 180)
    step = max(1, round(source_fps / max(1, args.fps)))
    analysis_fps = source_fps / step
    ocr, ocr_device = create_ocr(args.ocr, args.device)
    ocr_stride = max(1, round(analysis_fps / 4))
    frames: list[dict[str, Any]] = []
    observations: list[dict[str, Any]] = []
    previous = None
    index = 0
    sampled = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        time = index / source_fps
        if time > duration:
            break
        if index % step:
            index += 1
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, (320, 180), interpolation=cv2.INTER_AREA)
        difference = 0.0 if previous is None else float(np.mean(cv2.absdiff(gray, previous)) / 255.0)
        flow = {"dx": 0.0, "dy": 0.0, "magnitude": 0.0} if previous is None else optical_flow(previous, gray)
        frames.append({
            "time": time,
            "changeScore": difference,
            "meanLuma": float(np.mean(gray) / 255.0),
            "blackRatio": float(np.mean(gray <= 18)),
            "foreground": foreground(gray),
            "components": large_components(gray),
            "flow": flow,
        })
        if sampled % ocr_stride == 0:
            observations.extend(ocr_frame(ocr, frame, time))
        previous = gray
        sampled += 1
        index += 1
    capture.release()
    print(json.dumps({
        "provider": "tempo-opencv-paddleocr",
        "analysisFps": analysis_fps,
        "width": 320,
        "height": 180,
        "frames": frames,
        "textObservations": observations,
        "ocrAvailable": ocr is not None,
        "ocrDevice": ocr_device,
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
