"""Optional deep analysis with Claude (vision).

Sends key frames plus the measured metrics to Claude and gets back a structured
critique: what is in the ad, a virality estimate, audiences, copy for every
platform and concrete fixes. Without an API key AdLab still works using its
built-in rules; this layer just makes the advice specific to your actual ad.
"""

from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path

from PIL import Image

MODEL = os.environ.get("ADLAB_MODEL", "claude-opus-5-5")

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["what_we_see", "virality_score", "virality_reasoning", "strengths", "weaknesses",
                 "audiences", "hook_text", "cta_text", "captions", "hashtags", "recommendations",
                 "reshoot_ideas", "detected_category"],
    "properties": {
        "what_we_see": {"type": "string"},
        "detected_category": {"type": "string", "enum": [
            "furniture", "fashion", "food", "beauty", "real_estate", "auto", "electronics", "services", "general"]},
        "virality_score": {"type": "integer"},
        "virality_reasoning": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "weaknesses": {"type": "array", "items": {"type": "string"}},
        "audiences": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["name", "age_range", "gender", "interests", "locations", "angle"],
            "properties": {
                "name": {"type": "string"}, "age_range": {"type": "string"}, "gender": {"type": "string"},
                "interests": {"type": "array", "items": {"type": "string"}},
                "locations": {"type": "array", "items": {"type": "string"}},
                "angle": {"type": "string"},
            }}},
        "hook_text": {"type": "string"},
        "cta_text": {"type": "string"},
        "captions": {"type": "object", "additionalProperties": False,
                     "required": ["tiktok", "instagram", "facebook", "whatsapp"],
                     "properties": {k: {"type": "string"} for k in ["tiktok", "instagram", "facebook", "whatsapp"]}},
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "recommendations": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["text", "priority"],
            "properties": {"text": {"type": "string"},
                           "priority": {"type": "string", "enum": ["high", "medium", "low"]}}}},
        "reshoot_ideas": {"type": "array", "items": {"type": "string"}},
    },
}

SYSTEM = """You are a performance-marketing creative strategist who has run thousands of \
paid social campaigns for small businesses, especially in African markets and their diasporas. \
You review an advert (key frames from a video, or a photo) together with measured technical \
metrics and the business details, then give specific, practical advice a small business owner \
can act on today.

Be honest: a score of 50 is average, 80+ is genuinely strong. Base the score on the hook, \
clarity of the product, trust signals, emotional pull, offer/price clarity, call to action, \
and fit with how people scroll on TikTok/Reels/Facebook.

hook_text: at most 8 words, for the first 3 seconds of the video or the top of the image.
cta_text: at most 8 words, telling people exactly how to buy (use the contact details given).
Write captions in the voice of the business, ready to paste, with emojis where natural. \
Hashtags: 8-15, a mix of broad and local."""


def available() -> bool:
    if os.environ.get("ADLAB_DISABLE_AI"):
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                or os.environ.get("ANTHROPIC_PROFILE")
                or (Path.home() / ".config" / "anthropic").exists())


def _image_block(path: str) -> dict:
    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((1024, 1024))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.standard_b64encode(buf.getvalue()).decode()}}


def analyze(frame_paths: list[str], business: dict, metrics: dict) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    content: list[dict] = []
    for i, p in enumerate(frame_paths[:6]):
        label = "Opening frame (the hook)" if i == 0 else f"Frame {i + 1}"
        content.append({"type": "text", "text": label})
        content.append(_image_block(p))
    content.append({"type": "text", "text": (
        "Business details:\n" + json.dumps(business, indent=2) +
        "\n\nMeasured metrics:\n" + json.dumps(metrics, indent=2) +
        "\n\nReview this advert and fill in every field."
    )})

    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            messages=[{"role": "user", "content": content}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError:
        return {"error": "Your Anthropic API key was rejected. Check ANTHROPIC_API_KEY."}
    except anthropic.RateLimitError:
        return {"error": "Claude is rate-limited right now; showing built-in analysis only. Try again in a minute."}
    except anthropic.APIStatusError as e:
        return {"error": f"Claude API error ({e.status_code}): {e.message}"}
    except anthropic.APIConnectionError:
        return {"error": "Could not reach the Claude API (network). Showing built-in analysis only."}

    if msg.stop_reason == "refusal":
        return {"error": "Claude declined to analyse this advert."}
    if msg.stop_reason == "max_tokens":
        return {"error": "Claude's answer was cut off; showing built-in analysis only."}
    text = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"error": "Claude returned an unreadable answer; showing built-in analysis only."}
