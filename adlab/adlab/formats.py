"""Produce platform-ready versions of an advert and apply the automatic fixes."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from .media import MediaReport, require_ffmpeg


@dataclass(frozen=True)
class Spec:
    key: str
    label: str
    width: int
    height: int
    max_seconds: int  # longest video the placement accepts (or that performs)
    ideal_seconds: int
    bottom_safe: float = 0.0  # fraction of the bottom covered by app UI (captions, buttons)
    top_safe: float = 0.0


SPECS: dict[str, Spec] = {s.key: s for s in [
    Spec("tiktok", "TikTok 9:16", 1080, 1920, 180, 21, 0.22, 0.10),
    Spec("instagram_reel", "Instagram Reel 9:16", 1080, 1920, 90, 20, 0.22, 0.10),
    Spec("instagram_story", "Instagram/Facebook Story 9:16", 1080, 1920, 60, 15, 0.18, 0.12),
    Spec("instagram_feed", "Instagram feed 4:5", 1080, 1350, 60, 20),
    Spec("facebook_feed", "Facebook feed 4:5", 1080, 1350, 120, 20),
    Spec("facebook_story", "Facebook Story/Reel 9:16", 1080, 1920, 60, 15, 0.20, 0.10),
    Spec("square", "Square 1:1 (FB/IG/X/LinkedIn)", 1080, 1080, 60, 20),
    Spec("whatsapp_status", "WhatsApp Status 9:16", 1080, 1920, 60, 20, 0.10, 0.08),
    Spec("youtube_short", "YouTube Short 9:16", 1080, 1920, 60, 25, 0.20, 0.08),
    Spec("youtube", "YouTube 16:9", 1920, 1080, 600, 30),
    Spec("x_post", "X (Twitter) 16:9", 1600, 900, 140, 20),
    Spec("linkedin", "LinkedIn 1.91:1", 1200, 627, 600, 30),
    Spec("pinterest", "Pinterest 2:3", 1000, 1500, 60, 15),
    Spec("snapchat", "Snapchat 9:16", 1080, 1920, 60, 10, 0.15, 0.10),
]}

ACTIONS = {
    "enhance": "Auto-correct exposure, contrast and colour",
    "sharpen": "Sharpen",
    "reformat": "Make vertical / per-platform sizes (blurred fill, nothing cropped)",
    "upscale": "Upscale to platform resolution",
    "trim": "Trim video to the ideal length for each platform",
    "hook_text": "Add a bold text hook for the first 3 seconds",
    "price_cta": "Add price + call-to-action banner",
    "watermark": "Add brand name / logo",
    "normalize_audio": "Normalise loudness to -14 LUFS",
}

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default(size=size)


@dataclass
class Branding:
    brand: str = ""
    hook: str = ""
    price: str = ""
    cta: str = ""
    logo_path: str | None = None
    color: str = "#F5B700"  # banner accent


@dataclass
class RenderJob:
    actions: set[str]
    targets: list[str]
    branding: Branding = field(default_factory=Branding)


# ---------------------------------------------------------------------------
# Overlays (drawn once with Pillow, used for both images and videos)
# ---------------------------------------------------------------------------

def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    # Keep phone numbers / prices together: glue digit groups with a no-break space.
    text = re.sub(r"(?<=\d) (?=\d)", "\u00a0", text)
    words, lines, cur = [w for w in text.split(" ") if w], [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _fit_text(draw, text: str, max_w: int, max_lines: int, start: int, min_size: int = 18):
    # Prefer fewer lines: shrink up to 35% on one line before allowing a second, etc.
    for n in range(1, max_lines + 1):
        floor = int(start * 0.65) if n < max_lines else min_size
        size = start
        while size >= floor:
            font = _font(size)
            lines = _wrap(draw, text, font, max_w)
            if len(lines) <= n and all(draw.textlength(l, font=font) <= max_w for l in lines):
                return font, lines
            size -= 3
    font = _font(min_size)
    return font, _wrap(draw, text, font, max_w)[:max_lines]


def _text_block(draw, lines, font, cx, y, fill, stroke=0, stroke_fill="black", spacing=1.15) -> int:
    lh = int(font.size * spacing)
    for line in lines:
        w = draw.textlength(line, font=font)
        draw.text((cx - w / 2, y), line, font=font, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        y += lh
    return y


def persistent_overlay(spec: Spec, b: Branding, actions: set[str]) -> Image.Image | None:
    """Brand mark (top) and price/CTA banner (bottom, above the app's UI area)."""
    W, H = spec.width, spec.height
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    used = False
    unit = min(W, H)

    if "watermark" in actions and (b.brand or b.logo_path):
        used = True
        pad = int(unit * 0.035)
        y = int(H * spec.top_safe) + pad
        x = pad
        if b.logo_path and Path(b.logo_path).exists():
            logo = ImageOps.exif_transpose(Image.open(b.logo_path)).convert("RGBA")
            logo.thumbnail((int(unit * 0.16), int(unit * 0.16)))
            layer.alpha_composite(logo, (x, y))
            x += logo.width + pad // 2
        if b.brand:
            f = _font(int(unit * 0.04))
            d.text((x, y + 4), b.brand, font=f, fill=(255, 255, 255, 235), stroke_width=3, stroke_fill=(0, 0, 0, 160))

    if "price_cta" in actions and (b.price or b.cta):
        used = True
        bw = int(W * 0.86)
        margin_bottom = int(H * spec.bottom_safe) + int(unit * 0.04)
        price_font = _font(int(unit * 0.075))
        cta_font, cta_lines = _fit_text(d, b.cta, bw - 40, 2, int(unit * 0.045)) if b.cta else (None, [])
        ph = int(price_font.size * 1.3) if b.price else 0
        ch = int(cta_font.size * 1.2) * len(cta_lines) if cta_font else 0
        bh = ph + ch + int(unit * 0.05)
        x0, y1 = (W - bw) // 2, H - margin_bottom
        y0 = y1 - bh
        d.rounded_rectangle((x0, y0, x0 + bw, y1), radius=int(unit * 0.03), fill=(0, 0, 0, 185))
        d.rounded_rectangle((x0, y0, x0 + bw, y0 + 8), radius=4, fill=b.color)
        y = y0 + int(unit * 0.025)
        if b.price:
            y = _text_block(d, [b.price], price_font, W // 2, y, b.color)
        if cta_lines:
            _text_block(d, cta_lines, cta_font, W // 2, y, "white")
    return layer if used else None


def hook_overlay(spec: Spec, b: Branding) -> Image.Image | None:
    if not b.hook:
        return None
    W, H = spec.width, spec.height
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    unit = min(W, H)
    font, lines = _fit_text(d, b.hook.upper(), int(W * 0.84), 3, int(unit * 0.085))
    y = int(H * max(spec.top_safe, 0.06)) + int(unit * 0.12)
    lh = int(font.size * 1.15)
    box_h = lh * len(lines) + int(unit * 0.04)
    d.rounded_rectangle((int(W * 0.05), y - int(unit * 0.02), int(W * 0.95), y + box_h - int(unit * 0.02)),
                        radius=int(unit * 0.03), fill=(255, 255, 255, 230))
    _text_block(d, lines, font, W // 2, y, (15, 15, 15))
    return layer


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

def _enhance_image(img: Image.Image, media: MediaReport, actions: set[str]) -> Image.Image:
    a = media.avg
    if "enhance" in actions:
        img = Image.blend(img, ImageOps.autocontrast(img, cutoff=0.5, preserve_tone=True), 0.6)
        if a.brightness < 95:
            img = ImageEnhance.Brightness(img).enhance(min(1.35, 110 / max(a.brightness, 30)))
        elif a.brightness > 185:
            img = ImageEnhance.Brightness(img).enhance(0.92)
        img = ImageEnhance.Color(img).enhance(1.18 if a.colorfulness < 45 else 1.08)
        img = ImageEnhance.Contrast(img).enhance(1.06)
    if "sharpen" in actions:
        img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=90, threshold=3))
    return img


def _fit_canvas(img: Image.Image, W: int, H: int, fill_mode: str) -> Image.Image:
    if fill_mode == "crop":
        return ImageOps.fit(img, (W, H), Image.LANCZOS, centering=(0.5, 0.45))
    bg = ImageOps.fit(img, (W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(radius=max(W, H) // 30))
    bg = ImageEnhance.Brightness(bg).enhance(0.6)
    fg = ImageOps.contain(img, (W, H), Image.LANCZOS)
    bg.paste(fg, ((W - fg.width) // 2, (H - fg.height) // 2))
    return bg


def _aspect_close(media: MediaReport, spec: Spec) -> bool:
    return abs(media.aspect - spec.width / spec.height) / (spec.width / spec.height) < 0.12


def render_image(src: Path, media: MediaReport, job: RenderJob, out_dir: Path) -> list[Path]:
    img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    img = _enhance_image(img, media, job.actions)
    outs = []
    for key in job.targets:
        spec = SPECS[key]
        mode = "crop" if _aspect_close(media, spec) else "blur"
        canvas = _fit_canvas(img, spec.width, spec.height, mode).convert("RGBA")
        for ov in (hook_overlay(spec, job.branding) if "hook_text" in job.actions else None,
                   persistent_overlay(spec, job.branding, job.actions)):
            if ov is not None:
                canvas.alpha_composite(ov)
        p = out_dir / f"{src.stem}_{key}.jpg"
        canvas.convert("RGB").save(p, quality=92, optimize=True, progressive=True)
        outs.append(p)
    return outs


# ---------------------------------------------------------------------------
# Videos
# ---------------------------------------------------------------------------

def _video_filters(media: MediaReport, spec: Spec, actions: set[str], fill_mode: str) -> str:
    W, H = spec.width, spec.height
    a = media.avg
    pre = []
    if "enhance" in actions:
        br = 0.06 if a.brightness < 90 else -0.04 if a.brightness > 185 else 0.0
        sat = 1.25 if a.colorfulness < 45 else 1.1
        ct = 1.12 if a.contrast < 45 else 1.04
        pre.append(f"eq=brightness={br}:contrast={ct}:saturation={sat}")
    if "sharpen" in actions:
        pre.append("unsharp=5:5:0.8:5:5:0.0")
    pre_s = (",".join(pre) + ",") if pre else ""
    if fill_mode == "crop":
        return (f"[0:v]{pre_s}scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                f"setsar=1,fps=30[base]")
    return (
        f"[0:v]{pre_s}split=2[a][b];"
        f"[a]scale={W // 4}:{H // 4}:force_original_aspect_ratio=increase,crop={W // 4}:{H // 4},"
        f"boxblur=10:2,eq=brightness=-0.12,scale={W}:{H}[bg];"
        f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30[base]"
    )


def render_video(src: Path, media: MediaReport, job: RenderJob, out_dir: Path) -> list[Path]:
    require_ffmpeg()
    outs = []
    tmp = out_dir / "_overlays"
    tmp.mkdir(exist_ok=True)
    for key in job.targets:
        spec = SPECS[key]
        mode = "crop" if _aspect_close(media, spec) else "blur"
        graph = _video_filters(media, spec, job.actions, mode)
        inputs = ["-i", str(src)]
        last = "base"
        idx = 1
        hook = hook_overlay(spec, job.branding) if "hook_text" in job.actions else None
        if hook is not None:
            hp = tmp / f"hook_{key}.png"
            hook.save(hp)
            inputs += ["-i", str(hp)]
            graph += f";[{last}][{idx}:v]overlay=0:0:enable='lt(t,3)'[v{idx}]"
            last, idx = f"v{idx}", idx + 1
        pers = persistent_overlay(spec, job.branding, job.actions)
        if pers is not None:
            pp = tmp / f"persist_{key}.png"
            pers.save(pp)
            inputs += ["-i", str(pp)]
            graph += f";[{last}][{idx}:v]overlay=0:0[v{idx}]"
            last, idx = f"v{idx}", idx + 1
        graph += f";[{last}]format=yuv420p[vout]"

        cmd = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[vout]"]
        if media.has_audio:
            cmd += ["-map", "0:a:0"]
            if "normalize_audio" in job.actions:
                cmd += ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"]
            cmd += ["-c:a", "aac", "-b:a", "128k", "-ar", "44100"]
        if "trim" in job.actions and media.duration > spec.ideal_seconds * 1.4:
            cmd += ["-t", str(min(spec.max_seconds, max(spec.ideal_seconds, 15)))]
        elif media.duration > spec.max_seconds:
            cmd += ["-t", str(spec.max_seconds)]
        p = out_dir / f"{src.stem}_{key}.mp4"
        cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "22", "-profile:v", "high",
                "-movflags", "+faststart", "-shortest", str(p)]
        r = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg failed for {key}: {r.stderr.strip()[-800:]}")
        outs.append(p)
    return outs


def render(src: str | Path, media: MediaReport, job: RenderJob, out_dir: str | Path) -> list[Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    src = Path(src)
    if media.kind == "image":
        return render_image(src, media, job, out)
    return render_video(src, media, job, out)


def targets_for_channels(channel_keys: list[str]) -> list[str]:
    from .market import CHANNELS

    seen: list[str] = []
    for k in channel_keys:
        for f in CHANNELS[k].formats:
            if f not in seen:
                seen.append(f)
    return seen
