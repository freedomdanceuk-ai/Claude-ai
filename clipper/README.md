# Clipper — automated video clipping

Turns a long video (podcast, stream, interview, webinar) into ready-to-post
vertical shorts for TikTok, Reels and YouTube Shorts.

```
long video ─► transcribe (Whisper) ─► pick highlights (Claude) ─► cut + 9:16 reframe + captions (ffmpeg)
```

Each clip gets:
- **Smart boundaries.** Clips start and end on sentence boundaries, never mid-word.
- **Vertical 1080×1920 reframing.** By default the crop follows the speaker's face.
  It can instead fit the video over a blurred background.
- **Word-by-word captions.** These are burned in, and the spoken word is highlighted in yellow.
- **Hook text.** It appears on screen for the first 3 seconds.
- **A `clips.json` manifest.** It lists each clip's title, hook, virality score and reason, which helps with writing captions and tracking performance.

## Setup

Requires Python 3.10+ and [ffmpeg](https://ffmpeg.org/download.html).

```bash
pip install -r clipper/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...   # optional, but much better clip selection
```

Without an API key the tool uses an offline heuristic. The heuristic favours dense, punchy speech and complete sentences.

## Usage

Run from the repository root:

```bash
python -m clipper podcast.mp4                       # 5 clips, 20–60s, into ./clips
python -m clipper podcast.mp4 -n 10 --min 15 --max 45 -o shorts
python -m clipper podcast.mp4 --reframe blur        # keep full frame over blurred bg
python -m clipper podcast.mp4 --dry-run             # just list the picks
python -m clipper podcast.mp4 --whisper-model medium  # more accurate transcription
```

| Option | Default | Description |
|---|---|---|
| `-n, --count` | 5 | Number of clips |
| `--min` / `--max` | 20 / 60 | Clip length range in seconds |
| `--reframe` | `crop` | `crop` follows the speaker's face, `blur` fits over a blurred background, `none` keeps the original aspect |
| `--whisper-model` | `small` | `tiny`, `base`, `small`, `medium` or `large-v3`. Larger is slower but more accurate |
| `--no-captions` | off | Skip burned-in captions |
| `--no-claude` | off | Force the offline heuristic |
| `-o, --out` | `clips` | Output directory |

The transcript is cached as `<out>/<video>.transcript.json`, so re-runs skip
transcription. This lets you try different `-n` or length settings quickly.

## How it works

| File | Role |
|---|---|
| `transcribe.py` | Uses faster-whisper to get word-level timestamps, then caches them |
| `highlights.py` | Sends the timestamped transcript to Claude, which returns ranked clips as structured JSON. Falls back to a heuristic. Snaps clips to segment boundaries and removes overlaps |
| `render.py` | Detects faces with OpenCV to place the crop, generates ASS karaoke captions, then cuts and encodes with ffmpeg |
| `cli.py` | Command-line interface |

## Notes

- Only clip content you own or have permission to repost.
- Face tracking uses a single crop position per clip, taken as the median face position, so the frame doesn't jitter. For two-person shots, `--reframe blur` often looks better.
