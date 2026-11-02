# Cutline: browser video editor

A video editor that runs entirely in your web browser. Your files are never
uploaded: they're opened, edited and exported on your own device.

## Run it

It's plain HTML/CSS/JS, so there's nothing to install or build.

```bash
cd video-editor
python3 -m http.server 8000
# open http://localhost:8000
```

You can also host the folder on any static host, such as GitHub Pages or Netlify.
Chrome or Edge works best; Firefox and Safari work too, with the limits listed below.

## Features

- **Import** video and audio by clicking Import or dragging files onto the page.
- **Timeline** with video, text and music tracks, filmstrip thumbnails, zoom (slider or Ctrl+scroll) and click/drag scrubbing.
- **Trim**: drag a clip's edges on the timeline, use the Start/End sliders, or set them from the playhead.
- **Split** at the playhead (`S`), **reorder** clips by dragging them, duplicate, delete.
- **Speed** from 0.25× to 4× (pitch preserved), **volume** up to 200%, mute per clip.
- **Fades** in and out per clip (picture and sound).
- **Rotate**, mirror and zoom, which helps fix sideways phone videos.
- **Looks**: Vivid, Warm, Cool, Cinematic, Vintage, B&W, Noir, Dreamy, plus manual brightness, contrast, saturation, hue, grayscale, sepia and blur. "Apply look to all clips" copies the current look to every clip.
- **Text / captions**: font, size, colour, outline, background box, and Fade / Pop / Slide / Typewriter animations. Drag text on the preview to place it, or drag and resize its block on the timeline.
- **Background music** with volume, start offset, fade in/out, looping, and a one-click "mute all clip audio".
- **Formats**: 16:9, 9:16 (Reels/TikTok/Shorts), 1:1, 4:5, 4:3, 21:9 at 480p, 720p or 1080p. When a clip doesn't match the frame, choose bars, blurred background or crop-to-fill.
- **Undo / redo** (Ctrl+Z / Ctrl+Shift+Z).
- **Export** to MP4 (H.264) where the browser supports it, otherwise WebM. You get a preview and a download button.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Step one frame (Shift: 1 second) |
| S | Split at playhead |
| T | Add text |
| Delete | Delete selected clip or text |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Home / End | Jump to start / end |

## How it works

- Each imported file becomes an object URL that feeds a hidden `<video>`/`<audio>` element.
- The preview is a `<canvas>`. Every frame, the active clip is drawn with its filters, rotation and fades, and the text layers are drawn on top.
- Audio goes through the Web Audio API so clip volume, fades and music can be mixed.
- Export plays the timeline in real time, captures the canvas (`captureStream`) and the audio mix, and records them with `MediaRecorder`. WebM files are patched afterwards so they report the correct duration.

## Limitations

- Export runs in **real time** (a 2-minute video takes about 2 minutes), and the tab must stay visible while it runs.
- Codec support depends on the browser. iPhone HEVC `.mov` files play in Safari but may not open in Chrome or Firefox.
- MP4 export requires a recent Chrome or Edge, or Safari. Firefox exports WebM.
- Safari doesn't support canvas filters, so looks have no effect there.
- Projects aren't saved between sessions yet. Export your video before closing the tab.
