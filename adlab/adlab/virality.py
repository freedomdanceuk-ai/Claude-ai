"""Rule-based virality score and fix list.

The score blends what short-form platforms reward: a strong first second, native
vertical format, the right length and pace, clean visuals, sound, and a clear
offer + call to action. Each finding can carry an automatic fix ("action")
that formats.render() knows how to apply.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from .media import MediaReport

CTA_WORDS = ("order", "buy", "shop", "call", "whatsapp", "dm", "message", "book", "visit", "click",
             "tap", "get yours", "inbox", "link in bio", "save", "share")


@dataclass
class Recommendation:
    text: str
    priority: str  # high | medium | low
    action: str | None = None  # auto-fix id, see formats.ACTIONS


@dataclass
class Factor:
    name: str
    score: float  # 0-100
    weight: float
    detail: str
    recs: list[Recommendation] = field(default_factory=list)


@dataclass
class ViralityReport:
    score: int
    grade: str
    verdict: str
    factors: list[Factor]

    @property
    def recommendations(self) -> list[Recommendation]:
        order = {"high": 0, "medium": 1, "low": 2}
        recs = [r for f in sorted(self.factors, key=lambda f: f.score) for r in f.recs]
        return sorted(recs, key=lambda r: order[r.priority])

    def to_dict(self) -> dict:
        d = asdict(self)
        d["recommendations"] = [asdict(r) for r in self.recommendations]
        return d


def _band(value: float, lo: float, hi: float, soft: float) -> float:
    """100 inside [lo, hi], falling linearly to 0 at `soft` outside the band."""
    if lo <= value <= hi:
        return 100.0
    dist = lo - value if value < lo else value - hi
    return max(0.0, 100.0 * (1 - dist / soft))


def _clamp(x: float) -> float:
    return max(0.0, min(100.0, x))


def score(media: MediaReport, ad_text: str = "", price: str = "") -> ViralityReport:
    a = media.avg
    first = media.frames[0]
    factors: list[Factor] = []
    is_video = media.kind == "video"

    # 1. Hook / scroll-stopping power of the first moment
    stop = 0.35 * _clamp(first.contrast / 65 * 100) + 0.35 * _clamp(first.colorfulness / 60 * 100) \
        + 0.3 * _band(first.brightness, 85, 185, 70)
    if is_video:
        motion = _band(media.opening_motion, 6, 40, 25)
        hook = 0.55 * stop + 0.45 * motion
        detail = f"First-frame contrast {first.contrast:.0f}, colour {first.colorfulness:.0f}, opening motion {media.opening_motion:.1f}."
    else:
        hook = 0.8 * stop + 0.2 * _clamp(first.center_focus / 1.4 * 100)
        detail = f"Contrast {first.contrast:.0f}, colour {first.colorfulness:.0f}, subject focus {first.center_focus:.2f}."
    f = Factor("Hook (first second)", hook, 0.25, detail)
    if hook < 70:
        f.recs.append(Recommendation(
            "Open with your strongest shot and a bold text hook in the first second "
            "(e.g. a question or the price). Viewers decide in under 2 seconds.", "high", "hook_text"))
    if is_video and media.opening_motion < 4:
        f.recs.append(Recommendation(
            "The opening is static. Start mid-action (movement, reveal, hand interacting with the product).", "high"))
    factors.append(f)

    # 2. Format fit for short-form feeds
    fmt = {"vertical": 100.0, "square": 65.0, "horizontal": 35.0}[media.orientation]
    f = Factor("Format (vertical 9:16)", fmt, 0.15, f"{media.width}x{media.height} ({media.orientation}).")
    if media.orientation != "vertical":
        f.recs.append(Recommendation(
            "Short-form feeds (TikTok, Reels, Shorts, Status) are vertical. AdLab will create 9:16 versions "
            "with a blurred fill so nothing gets cut off. Film vertically next time.", "high", "reformat"))
    if min(media.width, media.height) < 720:
        f.recs.append(Recommendation("Resolution is low (< 720p). Shoot at 1080p or higher.", "medium", "upscale"))
        f.score = min(f.score, 60)
    factors.append(f)

    # 3. Length and pacing (video only)
    if is_video:
        d = media.duration
        length = _band(d, 8, 30, 45)
        f = Factor("Length", length, 0.12, f"{d:.1f} s long.")
        if d > 30:
            f.recs.append(Recommendation(
                f"At {d:.0f} s it is long for a feed ad. Cut to 15-30 s; AdLab can trim it and keep the opening.",
                "high" if d > 60 else "medium", "trim"))
        elif d < 6:
            f.recs.append(Recommendation("Very short. 9-20 s lets you show the product, proof and the offer.", "low"))
        factors.append(f)

        pace = _band(media.cuts_per_10s, 1.5, 6, 4)
        f = Factor("Pacing (cuts)", pace, 0.1, f"{media.scene_cuts} cuts, {media.cuts_per_10s:.1f} per 10 s.")
        if media.cuts_per_10s < 1.5:
            f.recs.append(Recommendation(
                "Few cuts. Change angle or shot every 2-3 seconds (wide, close-up, detail, reaction) to hold attention.",
                "medium"))
        elif media.cuts_per_10s > 6:
            f.recs.append(Recommendation("Very fast cutting can feel chaotic; let key shots breathe.", "low"))
        factors.append(f)

        if not media.has_audio:
            snd = 30.0
            sdetail = "No audio track."
        elif media.loudness_lufs is None:
            snd = 60.0
            sdetail = "Audio present, loudness unknown."
        else:
            snd = _band(media.loudness_lufs, -16, -10, 12)
            sdetail = f"Integrated loudness {media.loudness_lufs:.1f} LUFS (target about -14)."
        f = Factor("Sound", snd, 0.1, sdetail)
        if not media.has_audio:
            f.recs.append(Recommendation(
                "Add a trending sound or voice-over in the TikTok/Instagram editor: sound-on content gets more reach.",
                "high"))
        elif snd < 80:
            f.recs.append(Recommendation("Volume is off target. AdLab will normalise loudness to -14 LUFS.", "medium",
                                         "normalize_audio"))
        factors.append(f)

    # 4. Visual quality
    sharp = _clamp(a.sharpness / 300 * 100)
    expo = _band(a.brightness, 90, 180, 70)
    contrast = _clamp(a.contrast / 55 * 100)
    quality = 0.4 * sharp + 0.35 * expo + 0.25 * contrast
    f = Factor("Picture quality", quality, 0.15 if is_video else 0.25,
               f"Brightness {a.brightness:.0f}, contrast {a.contrast:.0f}, sharpness {a.sharpness:.0f}.")
    if expo < 80 or contrast < 75:
        what = "too dark" if a.brightness < 90 else "too bright" if a.brightness > 180 else "flat"
        f.recs.append(Recommendation(f"Image looks {what}. AdLab will auto-correct exposure, contrast and colour.",
                                     "high" if expo < 50 else "medium", "enhance"))
    if sharp < 60:
        f.recs.append(Recommendation("Slightly soft/blurry. AdLab will sharpen; next time wipe the lens and tap to focus.",
                                     "medium", "sharpen"))
    factors.append(f)

    # 5. Colour / eye-catch
    color = _clamp(a.colorfulness / 55 * 100)
    f = Factor("Colour & eye-catch", color, 0.08, f"Colourfulness {a.colorfulness:.0f}, saturation {a.saturation:.0f}.")
    if color < 60:
        f.recs.append(Recommendation("Colours are dull. A warmer, more saturated grade stands out in the feed.", "medium",
                                     "enhance"))
    factors.append(f)

    # 6. Message: price, CTA, hook copy
    text = f"{ad_text} {price}".lower()
    has_price = bool(price.strip()) or bool(re.search(r"(\$|usd|zar|r\s?\d|ksh|₦|£|€)\s?\d|\d+\s?(usd|dollars)", text))
    has_cta = any(w in text for w in CTA_WORDS)
    has_question = "?" in text
    msg = 30 + 35 * has_price + 25 * has_cta + 10 * has_question
    f = Factor("Offer & call to action", msg, 0.15 if is_video else 0.27,
               f"Price shown: {'yes' if has_price else 'no'}; CTA: {'yes' if has_cta else 'no'}.")
    if not has_price:
        f.recs.append(Recommendation(
            "Show the price (or 'From $X'). 'DM for price' loses most buyers. Fill in the price field and AdLab "
            "will put it on the advert.", "high", "price_cta"))
    if not has_cta:
        f.recs.append(Recommendation(
            "Tell people exactly what to do: 'Order on WhatsApp 07xx xxx xxx'. AdLab adds a CTA banner.", "high",
            "price_cta"))
    f.recs.append(Recommendation("Add your logo/brand name so every share builds recognition.", "low", "watermark"))
    factors.append(f)

    total_w = sum(x.weight for x in factors)
    total = sum(x.score * x.weight for x in factors) / total_w
    s = int(round(total))
    grade = "A" if s >= 85 else "B" if s >= 72 else "C" if s >= 58 else "D" if s >= 45 else "E"
    verdict = {
        "A": "Strong viral potential. Post it and put budget behind it once early numbers confirm.",
        "B": "Good. Apply the fixes below and it is ready to boost.",
        "C": "Average. It will get some reach; the fixes below should lift it noticeably.",
        "D": "Weak. Apply the fixes and consider re-shooting the opening.",
        "E": "Unlikely to perform as is. Re-shoot using the hook ideas below.",
    }[grade]
    return ViralityReport(s, grade, verdict, factors)
