"""Speech-to-text with word-level timestamps (faster-whisper), cached as JSON."""
import json
from pathlib import Path


def transcribe(video: Path, model_size: str = "small", cache_dir: Path | None = None) -> dict:
    cache = (cache_dir or video.parent) / f"{video.stem}.transcript.json"
    if cache.exists():
        return json.loads(cache.read_text())

    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="auto", compute_type="auto")
    segments, info = model.transcribe(str(video), word_timestamps=True, vad_filter=True)

    result = {"language": info.language, "duration": info.duration, "segments": []}
    for seg in segments:
        result["segments"].append({
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": seg.text.strip(),
            "words": [
                {"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word.strip()}
                for w in (seg.words or [])
            ],
        })
        print(f"  [{seg.start:7.1f}s] {seg.text.strip()[:80]}", flush=True)

    cache.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    return result
