"""Pick the most clip-worthy moments from a transcript.

Uses Claude when credentials are available; otherwise falls back to a
heuristic that favours dense, punchy speech.
"""
import json
import os
from dataclasses import dataclass

MODEL = "claude-opus-5-5"

SYSTEM = """You are an expert short-form video editor who clips long videos into \
viral TikToks, Reels and YouTube Shorts.

Pick the moments most likely to perform as standalone clips: strong hooks in the \
first 3 seconds, a complete thought or story with a payoff, bold opinions, humour, \
emotion, surprising facts, or clear actionable advice. A clip must make sense with \
no surrounding context. Never start mid-sentence; end on the payoff, not the wind-down.

Timestamps must come from the transcript's segment boundaries. Clips must not overlap."""

CLIP_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number", "description": "Start time in seconds"},
                    "end": {"type": "number", "description": "End time in seconds"},
                    "title": {"type": "string", "description": "Short catchy title, max 8 words"},
                    "hook": {"type": "string", "description": "On-screen hook text for the first seconds, max 6 words"},
                    "score": {"type": "integer", "description": "Predicted virality 1-100"},
                    "reason": {"type": "string", "description": "Why this moment works"},
                },
                "required": ["start", "end", "title", "hook", "score", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["clips"],
    "additionalProperties": False,
}


@dataclass
class Clip:
    start: float
    end: float
    title: str
    hook: str = ""
    score: int = 0
    reason: str = ""


def _has_claude_credentials() -> bool:
    return any(os.environ.get(k) for k in (
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID",
    )) or os.path.isdir(os.path.expanduser("~/.config/anthropic"))


def find_highlights(transcript: dict, count: int, min_len: float, max_len: float,
                    use_claude: bool = True) -> list[Clip]:
    if use_claude and _has_claude_credentials():
        try:
            clips = _claude_highlights(transcript, count, min_len, max_len)
        except Exception as e:  # network/auth/refusal: degrade to heuristic
            print(f"Claude highlight detection failed ({e}); using heuristic.")
        else:
            return _sanitize(clips, transcript, count, min_len, max_len)
    else:
        print("No Anthropic credentials found; using heuristic highlight detection.")
    return _sanitize(_heuristic_highlights(transcript, count, min_len, max_len),
                     transcript, count, min_len, max_len)


def _claude_highlights(transcript: dict, count: int, min_len: float, max_len: float) -> list[Clip]:
    import anthropic

    lines = "\n".join(f"[{s['start']:.2f}-{s['end']:.2f}] {s['text']}" for s in transcript["segments"])
    prompt = (
        f"Transcript of a {transcript['duration']:.0f}-second video, one segment per line "
        f"as [start-end] text:\n\n{lines}\n\n"
        f"Choose the {count} best clips, each {min_len:.0f}-{max_len:.0f} seconds long, "
        f"ranked best first."
    )

    client = anthropic.Anthropic()
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=64000,
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": CLIP_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    ) as stream:
        response = stream.get_final_message()

    if response.stop_reason == "refusal":
        raise RuntimeError(f"request declined ({response.stop_details})")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("response truncated")

    text = next(b.text for b in response.content if b.type == "text")
    return [Clip(**c) for c in json.loads(text)["clips"]]


def _heuristic_highlights(transcript: dict, count: int, min_len: float, max_len: float) -> list[Clip]:
    """Score windows of consecutive segments by speech density and punchiness."""
    segs = transcript["segments"]
    candidates = []
    for i in range(len(segs)):
        text, j = "", i
        while j < len(segs) and segs[j]["end"] - segs[i]["start"] <= max_len:
            text += " " + segs[j]["text"]
            dur = segs[j]["end"] - segs[i]["start"]
            if dur >= min_len:
                words = text.split()
                density = len(words) / dur
                punch = text.count("?") + text.count("!") * 1.5
                ends_clean = segs[j]["text"].rstrip().endswith((".", "!", "?"))
                score = density * 10 + punch * 3 + (5 if ends_clean else 0)
                candidates.append((score, segs[i]["start"], segs[j]["end"], text.strip()))
            j += 1

    candidates.sort(reverse=True)
    picked: list[Clip] = []
    for score, start, end, text in candidates:
        if any(start < c.end and end > c.start for c in picked):
            continue
        title = " ".join(text.split()[:8])
        picked.append(Clip(start, end, title, hook=" ".join(text.split()[:6]),
                           score=min(100, int(score)), reason="heuristic"))
        if len(picked) == count:
            break
    return picked


def _sanitize(clips: list[Clip], transcript: dict, count: int, min_len: float, max_len: float) -> list[Clip]:
    """Snap to segment boundaries, enforce lengths, and drop overlaps."""
    segs = transcript["segments"]
    starts = [s["start"] for s in segs]
    ends = [s["end"] for s in segs]
    out: list[Clip] = []
    for c in clips:
        c.start = min(starts, key=lambda t: abs(t - c.start)) if starts else c.start
        c.end = min(ends, key=lambda t: abs(t - c.end)) if ends else c.end
        if c.end - c.start > max_len:
            c.end = c.start + max_len
        if c.end - c.start < min_len * 0.5:
            continue
        if any(c.start < o.end and c.end > o.start for o in out):
            continue
        out.append(c)
    return out[:count]
