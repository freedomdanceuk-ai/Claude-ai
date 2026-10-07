"""Cut, reframe to vertical, and burn animated captions with ffmpeg."""
import re
import subprocess
from pathlib import Path

OUT_W, OUT_H = 1080, 1920


def probe_size(video: Path) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(video)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    w, h = out.split("x")[:2]
    return int(w), int(h)


def face_center_x(video: Path, start: float, end: float, samples: int = 12) -> float | None:
    """Median horizontal face position (0-1) across the clip, or None if no faces."""
    try:
        import cv2
        cv2.CascadeClassifier  # removed in OpenCV 5
    except (ImportError, AttributeError):
        return None
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    cap = cv2.VideoCapture(str(video))
    xs = []
    for k in range(samples):
        cap.set(cv2.CAP_PROP_POS_MSEC, (start + (end - start) * (k + 0.5) / samples) * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6,
                                         minSize=(gray.shape[0] // 12,) * 2)
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])  # largest face = speaker
            xs.append((x + w / 2) / frame.shape[1])
    cap.release()
    return sorted(xs)[len(xs) // 2] if xs else None


def reframe_filter(mode: str, src_w: int, src_h: int, center_x: float | None) -> str:
    if mode == "none":
        return f"scale={OUT_W}:-2"
    if mode == "blur":
        return (f"split[a][b];[a]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,"
                f"crop={OUT_W}:{OUT_H},boxblur=20:5[bg];"
                f"[b]scale={OUT_W}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2")
    # crop: follow the speaker's face, else centre
    crop_w = min(src_w, int(src_h * 9 / 16)) // 2 * 2
    cx = (center_x if center_x is not None else 0.5) * src_w
    x = int(max(0, min(src_w - crop_w, cx - crop_w / 2)))
    return f"crop={crop_w}:{src_h}:{x}:0,scale={OUT_W}:{OUT_H}"


def _ts(t: float) -> str:
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def _esc(text: str) -> str:
    return re.sub(r"[{}\\]", "", text).replace("\n", " ")


def build_ass(words: list[dict], hook: str, clip_len: float, words_per_line: int = 3) -> str:
    """Word-by-word captions: a few words on screen, the spoken one highlighted."""
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {OUT_W}
PlayResY: {OUT_H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,DejaVu Sans,86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,6,2,2,60,60,560,1
Style: Hook,DejaVu Sans,72,&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,18,0,8,80,80,260,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    if hook:
        events.append(f"Dialogue: 1,{_ts(0)},{_ts(min(3.5, clip_len))},Hook,,0,0,0,,"
                      f"{{\\fad(150,250)}}{_esc(hook).upper()}")

    for i in range(0, len(words), words_per_line):
        group = words[i:i + words_per_line]
        for j, w in enumerate(group):
            start = w["start"]
            end = group[j + 1]["start"] if j + 1 < len(group) else w["end"]
            parts = []
            for k, g in enumerate(group):
                token = _esc(g["word"]).upper()
                parts.append(f"{{\\c&H00E5FF&\\fscx110\\fscy110}}{token}{{\\r}}" if k == j else token)
            events.append(f"Dialogue: 0,{_ts(start)},{_ts(end)},Caption,,0,0,0,,{' '.join(parts)}")
    return header + "\n".join(events) + "\n"


def clip_words(transcript: dict, start: float, end: float) -> list[dict]:
    """Words inside [start, end], re-timed relative to the clip start."""
    out = []
    for seg in transcript["segments"]:
        for w in seg["words"]:
            if w["start"] >= start - 0.05 and w["end"] <= end + 0.05 and w["word"]:
                out.append({"start": w["start"] - start, "end": w["end"] - start, "word": w["word"]})
    return out


def render_clip(video: Path, transcript: dict, clip, out_dir: Path, name: str,
                mode: str = "crop", captions: bool = True, pad: float = 0.15) -> Path:
    start = max(0.0, clip.start - pad)
    end = clip.end + pad
    duration = end - start
    src_w, src_h = probe_size(video)

    center = face_center_x(video, start, end) if mode == "crop" else None
    vf = reframe_filter(mode, src_w, src_h, center)

    if captions:
        ass = out_dir / f"{name}.ass"
        ass.write_text(build_ass(clip_words(transcript, start, end), clip.hook, duration))
        vf += f",subtitles={ass.name}"

    out = out_dir / f"{name}.mp4"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(video.resolve()),
           "-t", f"{duration:.3f}", "-filter_complex", vf,
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out.name]
    # Run inside out_dir so the subtitles filter gets a path with no characters to escape.
    subprocess.run(cmd, check=True, cwd=out_dir)
    return out
