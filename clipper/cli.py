"""Command-line entry point: python -m clipper VIDEO [options]."""
import argparse
import json
import re
import shutil
import sys
from dataclasses import asdict
from pathlib import Path

from .highlights import find_highlights
from .render import render_clip
from .transcribe import transcribe


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "clip"


def main() -> None:
    p = argparse.ArgumentParser(prog="clipper", description="Turn a long video into captioned vertical shorts.")
    p.add_argument("video", type=Path, help="Input video file")
    p.add_argument("-o", "--out", type=Path, default=Path("clips"), help="Output directory (default: clips)")
    p.add_argument("-n", "--count", type=int, default=5, help="Number of clips to make (default: 5)")
    p.add_argument("--min", dest="min_len", type=float, default=20, help="Minimum clip length in seconds")
    p.add_argument("--max", dest="max_len", type=float, default=60, help="Maximum clip length in seconds")
    p.add_argument("--reframe", choices=["crop", "blur", "none"], default="crop",
                   help="crop: 9:16 following the speaker's face; blur: fit over blurred background; none: keep aspect")
    p.add_argument("--whisper-model", default="small", help="faster-whisper model size (tiny/base/small/medium/large-v3)")
    p.add_argument("--no-captions", action="store_true", help="Skip burned-in captions")
    p.add_argument("--no-claude", action="store_true", help="Use the offline heuristic instead of Claude")
    p.add_argument("--dry-run", action="store_true", help="Only list the chosen clips, don't render")
    args = p.parse_args()

    if not args.video.exists():
        sys.exit(f"File not found: {args.video}")
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required: https://ffmpeg.org/download.html")
    args.out.mkdir(parents=True, exist_ok=True)

    print(f"1/3 Transcribing {args.video.name} ...")
    transcript = transcribe(args.video, args.whisper_model, cache_dir=args.out)

    print("2/3 Finding highlights ...")
    clips = find_highlights(transcript, args.count, args.min_len, args.max_len, use_claude=not args.no_claude)
    if not clips:
        sys.exit("No suitable clips found.")
    for i, c in enumerate(clips, 1):
        print(f"  #{i} [{c.start:.1f}s-{c.end:.1f}s] ({c.end - c.start:.0f}s, score {c.score}) {c.title}")

    manifest = []
    if not args.dry_run:
        print("3/3 Rendering ...")
        for i, c in enumerate(clips, 1):
            name = f"{i:02d}-{slug(c.title)}"
            path = render_clip(args.video, transcript, c, args.out, name,
                               mode=args.reframe, captions=not args.no_captions)
            print(f"  wrote {path}")
            manifest.append({**asdict(c), "file": path.name})
    else:
        manifest = [asdict(c) for c in clips]

    (args.out / "clips.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"Done. Manifest: {args.out / 'clips.json'}")
