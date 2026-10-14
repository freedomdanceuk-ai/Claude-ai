"""Measure the technical qualities of a photo or video advert.

Everything here runs locally with Pillow, NumPy and ffmpeg/ffprobe.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".3gp"}


def media_kind(path: str | Path) -> str:
    ext = Path(path).suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    raise ValueError(f"Unsupported file type: {ext}")


def require_ffmpeg() -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError(
            "ffmpeg is required for video. Install it from https://ffmpeg.org/download.html "
            "(Windows: 'winget install ffmpeg', macOS: 'brew install ffmpeg')."
        )


@dataclass
class FrameMetrics:
    brightness: float  # 0-255 mean luma
    contrast: float  # std-dev of luma
    colorfulness: float  # Hasler-Susstrunk metric, ~0-150
    sharpness: float  # variance of Laplacian
    saturation: float  # 0-255 mean HSV saturation
    detail: float  # share of strong edges (busy-ness / text proxy), 0-1
    center_focus: float  # how much more detail sits in the centre than at the edges


@dataclass
class MediaReport:
    path: str
    kind: str
    width: int
    height: int
    aspect: float
    duration: float = 0.0
    fps: float = 0.0
    has_audio: bool = False
    loudness_lufs: float | None = None
    scene_cuts: int = 0
    cuts_per_10s: float = 0.0
    opening_motion: float = 0.0  # mean frame difference in the first 3 s (0-255)
    frames: list[FrameMetrics] = field(default_factory=list)
    frame_paths: list[str] = field(default_factory=list)

    @property
    def avg(self) -> FrameMetrics:
        keys = FrameMetrics.__dataclass_fields__.keys()
        return FrameMetrics(**{k: float(np.mean([getattr(f, k) for f in self.frames])) for k in keys})

    @property
    def orientation(self) -> str:
        if self.aspect < 0.9:
            return "vertical"
        if self.aspect > 1.1:
            return "horizontal"
        return "square"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["avg"] = asdict(self.avg)
        d["orientation"] = self.orientation
        return d


def _laplacian_var(gray: np.ndarray) -> float:
    g = gray.astype(np.float32)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


def frame_metrics(img: Image.Image) -> FrameMetrics:
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((640, 640))
    rgb = np.asarray(img).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    luma = 0.299 * r + 0.587 * g + 0.114 * b

    rg = np.abs(r - g)
    yb = np.abs(0.5 * (r + g) - b)
    colorfulness = float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2))

    hsv = np.asarray(img.convert("HSV")).astype(np.float32)

    gy, gx = np.gradient(luma)
    mag = np.hypot(gx, gy)
    edges = mag > 40
    h, w = edges.shape
    center = edges[h // 4: 3 * h // 4, w // 4: 3 * w // 4].mean()
    overall = edges.mean() + 1e-6

    return FrameMetrics(
        brightness=float(luma.mean()),
        contrast=float(luma.std()),
        colorfulness=colorfulness,
        sharpness=_laplacian_var(luma),
        saturation=float(hsv[..., 1].mean()),
        detail=float(overall),
        center_focus=float(center / overall),
    )


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def probe(path: str | Path) -> dict:
    require_ffmpeg()
    out = _run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)])
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {out.stderr.strip()}")
    return json.loads(out.stdout)


def _video_dims(info: dict) -> tuple[int, int, float, float]:
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    w, h = int(v["width"]), int(v["height"])
    rotation = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    rotation = int(v.get("tags", {}).get("rotate", rotation))
    if abs(rotation) in (90, 270):
        w, h = h, w
    num, den = (v.get("avg_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    duration = float(info["format"].get("duration") or v.get("duration") or 0)
    return w, h, fps, duration


def _scene_cuts(path: Path, threshold: float = 10.0) -> int:
    out = _run(["ffmpeg", "-hide_banner", "-i", str(path), "-vf", f"scale=320:-2,scdet=threshold={threshold}",
                "-an", "-f", "null", "-"])
    return len(re.findall(r"lavfi\.scd\.time", out.stderr))


def _loudness(path: Path) -> float | None:
    out = _run(["ffmpeg", "-hide_banner", "-i", str(path), "-vn", "-af", "ebur128", "-f", "null", "-"])
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", out.stderr)
    return float(m[-1]) if m else None


def _opening_motion(path: Path) -> float:
    """Mean absolute difference between consecutive low-res frames in the first 3 seconds."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-t", "3", "-i", str(path), "-vf", "fps=5,scale=64:64,format=gray",
         "-f", "rawvideo", "-"],
        capture_output=True, check=False,
    )
    data = np.frombuffer(out.stdout, dtype=np.uint8)
    n = data.size // (64 * 64)
    if n < 2:
        return 0.0
    frames = data[: n * 64 * 64].reshape(n, 64, 64).astype(np.float32)
    return float(np.abs(np.diff(frames, axis=0)).mean())


def extract_frames(path: Path, duration: float, out_dir: Path, count: int = 6) -> list[Path]:
    """Grab evenly spaced stills, always including the opening frame (the hook)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    times = [0.3] + [duration * (i + 1) / (count) for i in range(count - 1)]
    paths = []
    for i, t in enumerate(times):
        t = max(0.0, min(t, max(duration - 0.1, 0)))
        p = out_dir / f"frame_{i:02d}.jpg"
        _run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1",
              "-vf", "scale='min(960,iw)':-2", "-q:v", "3", str(p)])
        if p.exists():
            paths.append(p)
    return paths


def analyze_media(path: str | Path, work_dir: str | Path | None = None) -> MediaReport:
    path = Path(path)
    kind = media_kind(path)
    work = Path(work_dir or tempfile.mkdtemp(prefix="adlab_"))

    if kind == "image":
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            w, h = im.size
            preview = work / "frame_00.jpg"
            work.mkdir(parents=True, exist_ok=True)
            p = im.copy()
            p.thumbnail((1280, 1280))
            p.save(preview, quality=88)
            fm = frame_metrics(im)
        return MediaReport(str(path), kind, w, h, w / h, frames=[fm], frame_paths=[str(preview)])

    info = probe(path)
    w, h, fps, duration = _video_dims(info)
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])
    frame_paths = extract_frames(path, duration, work / "frames")
    frames = []
    for fp in frame_paths:
        with Image.open(fp) as im:
            frames.append(frame_metrics(im))
    cuts = _scene_cuts(path)
    return MediaReport(
        str(path), kind, w, h, w / h,
        duration=duration, fps=fps, has_audio=has_audio,
        loudness_lufs=_loudness(path) if has_audio else None,
        scene_cuts=cuts,
        cuts_per_10s=cuts / duration * 10 if duration else 0.0,
        opening_motion=_opening_motion(path),
        frames=frames, frame_paths=[str(p) for p in frame_paths],
    )
