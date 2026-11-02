/* Cutline: a browser-only video editor.
 * Everything happens locally: files are read with object URLs, frames are
 * composited on a <canvas>, audio is mixed with Web Audio, and export uses
 * MediaRecorder on the canvas + audio streams. */
'use strict';

/* ======================================================================
 * Helpers
 * ==================================================================== */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = (o) => JSON.parse(JSON.stringify(o));
const FRAME = 1 / 30;

function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
function fmtShort(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0');
  return `${m}:${ss}`;
}
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function once(el, ev, timeout = 0) {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(el.error || new Error('media error')); };
    const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok);
    el.addEventListener('error', bad);
    if (timeout) setTimeout(ok, timeout);
  });
}
function seekEl(el, time) {
  return new Promise((res) => {
    if (Math.abs(el.currentTime - time) < 0.001 && el.readyState >= 2) return res();
    let done = false;
    const fin = () => { if (done) return; done = true; el.removeEventListener('seeked', fin); res(); };
    el.addEventListener('seeked', fin);
    el.currentTime = time;
    setTimeout(fin, 2000);
  });
}

/* ======================================================================
 * Constants
 * ==================================================================== */
const DEFAULT_FILTERS = { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, blur: 0 };
const PRESETS = {
  none: { label: 'Original' },
  vivid: { label: 'Vivid', contrast: 112, saturate: 145 },
  warm: { label: 'Warm', sepia: 22, saturate: 125, brightness: 104 },
  cool: { label: 'Cool', hue: -12, saturate: 90, brightness: 102, contrast: 105 },
  cinematic: { label: 'Cinematic', contrast: 122, saturate: 80, brightness: 94 },
  vintage: { label: 'Vintage', sepia: 45, contrast: 88, brightness: 106, saturate: 85 },
  bw: { label: 'B&W', grayscale: 100, contrast: 118 },
  noir: { label: 'Noir', grayscale: 100, contrast: 160, brightness: 85 },
  dream: { label: 'Dreamy', brightness: 110, contrast: 90, saturate: 120, blur: 1 },
};
const FILTER_CTLS = [
  ['brightness', 'Brightness', 0, 200, '%'],
  ['contrast', 'Contrast', 0, 200, '%'],
  ['saturate', 'Saturation', 0, 300, '%'],
  ['hue', 'Hue', -180, 180, '°'],
  ['grayscale', 'Grayscale', 0, 100, '%'],
  ['sepia', 'Sepia', 0, 100, '%'],
  ['blur', 'Blur', 0, 20, ''],
];
const FONTS = {
  sans: { label: 'Sans', css: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  serif: { label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  display: { label: 'Impact', css: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
  mono: { label: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  script: { label: 'Script', css: '"Brush Script MT", "Segoe Script", "Snell Roundhand", cursive' },
};
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const ASPECTS = [
  ['auto', 'Original (first clip)'], ['16:9', '16:9 Landscape (YouTube)'], ['9:16', '9:16 Vertical (Reels / TikTok / Shorts)'],
  ['1:1', '1:1 Square'], ['4:5', '4:5 Portrait (Instagram feed)'], ['4:3', '4:3 Classic'], ['21:9', '21:9 Cinematic'],
];
const EXPORT_FORMATS = [
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'MP4 (H.264)', 'mp4'],
  ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'MP4 (H.264)', 'mp4'],
  ['video/mp4;codecs=avc1,mp4a', 'MP4 (H.264)', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'WebM (VP9)', 'webm'],
  ['video/webm;codecs=vp8,opus', 'WebM (VP8)', 'webm'],
  ['video/webm', 'WebM', 'webm'],
  ['video/mp4', 'MP4', 'mp4'], // last resort (Safari); codec chosen by the browser
];

/* ======================================================================
 * State
 * ==================================================================== */
/** media: id -> { id, name, kind, url, el, duration, width, height, thumb, strip, source, gain } */
const media = new Map();
const state = {
  clips: [],   // { id, mediaId, in, out, speed, volume, muted, fadeIn, fadeOut, rotate, flip, zoom, filters, preset }
  texts: [],   // { id, text, start, end, x, y, size, color, font, bold, outline, bg, bgColor, bgOpacity, anim }
  music: null, // { mediaId, volume, offset, fadeIn, fadeOut, loop }
  settings: { aspect: 'auto', quality: 720, fit: 'contain', bg: '#000000' },
};
let selection = { kind: null, id: null };
let activeTab = 'clip';
let zoomMult = 1;
let pps = 50; // timeline pixels per second

const player = {
  t: 0, playing: false, activeId: null, switching: false, raf: 0,
  exporting: false, seekToken: 0, onEnded: null,
};

/* ======================================================================
 * History (undo / redo)
 * ==================================================================== */
const history = { stack: [], idx: -1 };
const snapshot = () => JSON.stringify({ clips: state.clips, texts: state.texts, music: state.music, settings: state.settings });

function commit() {
  const s = snapshot();
  if (history.stack[history.idx] !== s) {
    history.stack = history.stack.slice(0, history.idx + 1);
    history.stack.push(s);
    if (history.stack.length > 200) history.stack.shift();
    history.idx = history.stack.length - 1;
  }
  refresh();
}
function restore(s) {
  pause();
  Object.assign(state, JSON.parse(s));
  if (selection.kind === 'clip' && !selectedClip()) selection = { kind: null, id: null };
  if (selection.kind === 'text' && !selectedText()) selection = { kind: null, id: null };
  refresh();
  seekTo(player.t);
}
function undo() { if (history.idx > 0) { history.idx--; restore(history.stack[history.idx]); } }
function redo() { if (history.idx < history.stack.length - 1) { history.idx++; restore(history.stack[history.idx]); } }

/* ======================================================================
 * Timeline model
 * ==================================================================== */
function segments() {
  let t = 0;
  const out = [];
  for (const clip of state.clips) {
    const m = media.get(clip.mediaId);
    if (!m) continue;
    const dur = Math.max(0.01, (clip.out - clip.in) / clip.speed);
    out.push({ clip, media: m, start: t, dur });
    t += dur;
  }
  return out;
}
const totalDuration = () => segments().reduce((a, s) => a + s.dur, 0);
function segAt(t) {
  const segs = segments();
  for (const s of segs) if (t < s.start + s.dur - 1e-6) return s;
  return segs[segs.length - 1] || null;
}
const segById = (id) => segments().find((s) => s.clip.id === id) || null;
const activeSeg = () => (player.activeId ? segById(player.activeId) : null);
const srcTime = (seg, t) => clamp(seg.clip.in + (t - seg.start) * seg.clip.speed, seg.clip.in, Math.max(seg.clip.in, seg.clip.out - 0.001));
const selectedClip = () => (selection.kind === 'clip' ? state.clips.find((c) => c.id === selection.id) : null);
const selectedText = () => (selection.kind === 'text' ? state.texts.find((t) => t.id === selection.id) : null);

function fadeAlpha(c, local, dur) {
  let a = 1;
  if (c.fadeIn > 0) a = Math.min(a, local / c.fadeIn);
  if (c.fadeOut > 0) a = Math.min(a, (dur - local) / c.fadeOut);
  return clamp(a, 0, 1);
}

/* ======================================================================
 * Audio graph
 * ==================================================================== */
let actx = null, master = null, monitor = null, recDest = null;
function ensureAudio() {
  if (actx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  actx = new AC();
  master = actx.createGain();
  monitor = actx.createGain();
  recDest = actx.createMediaStreamDestination();
  master.connect(monitor).connect(actx.destination);
  master.connect(recDest);
  for (const m of media.values()) connectMedia(m);
}
function connectMedia(m) {
  if (!actx || m.source) return;
  try {
    m.source = actx.createMediaElementSource(m.el);
    m.gain = actx.createGain();
    m.source.connect(m.gain).connect(master);
  } catch (e) { console.warn('audio routing failed', e); }
}
function setVol(m, v) {
  if (m.gain) m.gain.gain.value = Math.max(0, v);
  else m.el.volume = clamp(v, 0, 1);
}
function clipVolAt(seg, t) {
  const c = seg.clip;
  if (c.muted) return 0;
  return c.volume * fadeAlpha(c, t - seg.start, seg.dur);
}
function musicGainAt(t) {
  const mu = state.music;
  if (!mu) return 0;
  let g = mu.volume;
  const T = totalDuration();
  if (mu.fadeIn > 0 && t < mu.fadeIn) g *= t / mu.fadeIn;
  if (mu.fadeOut > 0 && t > T - mu.fadeOut) g *= Math.max(0, (T - t) / mu.fadeOut);
  return g;
}

/* ======================================================================
 * Playback engine
 * ==================================================================== */
async function seekTo(t, keepPlaying = true) {
  const T = totalDuration();
  t = clamp(t, 0, T);
  const wasPlaying = player.playing;
  if (wasPlaying) pause();
  player.t = t;
  const token = ++player.seekToken;
  const seg = segAt(t);
  updateTimeUI();
  if (!seg) { player.activeId = null; draw(); return; }
  player.activeId = seg.clip.id;
  await seekEl(seg.media.el, srcTime(seg, t));
  if (token !== player.seekToken) return;
  draw();
  if (wasPlaying && keepPlaying) play();
}

async function play() {
  if (player.playing || !state.clips.length) return;
  ensureAudio();
  if (actx && actx.state !== 'running') { try { await actx.resume(); } catch (_) { /* ignore */ } }
  const T = totalDuration();
  if (player.t >= T - 0.03) player.t = 0;
  player.playing = true;
  document.body.classList.add('playing');
  const seg = segAt(player.t);
  await startSeg(seg, player.t);
  startMusic();
  cancelAnimationFrame(player.raf);
  const tick = () => {
    if (!player.playing) return;
    step();
    player.raf = requestAnimationFrame(tick);
  };
  player.raf = requestAnimationFrame(tick);
}

function pause() {
  player.playing = false;
  cancelAnimationFrame(player.raf);
  for (const m of media.values()) if (!m.el.paused) m.el.pause();
  document.body.classList.remove('playing');
}
const togglePlay = () => (player.playing ? pause() : play());

async function startSeg(seg, t) {
  player.switching = true;
  player.activeId = seg.clip.id;
  const el = seg.media.el;
  const src = srcTime(seg, t);
  if (Math.abs(el.currentTime - src) > 0.04) await seekEl(el, src);
  if (!player.playing) { player.switching = false; return; }
  el.playbackRate = seg.clip.speed;
  setVol(seg.media, clipVolAt(seg, t));
  try { await el.play(); } catch (e) { console.warn(e); }
  player.switching = false;
}

function step() {
  if (player.switching) return;
  const seg = activeSeg();
  if (!seg) { pause(); return; }
  const el = seg.media.el;
  const c = seg.clip;
  if (el.currentTime >= c.out - 0.015 || el.ended) {
    player.t = seg.start + seg.dur;
    advance(seg);
    return;
  }
  player.t = clamp(seg.start + (el.currentTime - c.in) / c.speed, seg.start, seg.start + seg.dur);
  setVol(seg.media, clipVolAt(seg, player.t));
  syncMusic();
  draw();
  updateTimeUI(true);
}

async function advance(seg) {
  player.switching = true;
  seg.media.el.pause();
  const segs = segments();
  const i = segs.findIndex((s) => s.clip.id === seg.clip.id);
  const next = segs[i + 1];
  if (!next) {
    player.switching = false;
    pause();
    player.t = totalDuration();
    updateTimeUI();
    if (player.onEnded) { const f = player.onEnded; player.onEnded = null; f(); }
    return;
  }
  await startSeg(next, next.start);
}

function startMusic() {
  const mu = state.music;
  if (!mu) return;
  const m = media.get(mu.mediaId);
  if (!m) return;
  let pos = mu.offset + player.t;
  if (mu.loop) pos %= m.duration;
  else if (pos >= m.duration) return;
  m.el.loop = !!mu.loop;
  m.el.playbackRate = 1;
  m.el.currentTime = pos;
  setVol(m, musicGainAt(player.t));
  m.el.play().catch(() => {});
}
function syncMusic() {
  const mu = state.music;
  if (!mu) return;
  const m = media.get(mu.mediaId);
  if (!m) return;
  setVol(m, musicGainAt(player.t));
  if (!mu.loop) {
    const expected = mu.offset + player.t;
    if (expected < m.duration && Math.abs(m.el.currentTime - expected) > 0.25) m.el.currentTime = expected;
  }
}

/* ======================================================================
 * Rendering
 * ==================================================================== */
const canvas = $('#preview');
const ctx = canvas.getContext('2d');
const textBoxes = new Map();

function outputSize() {
  let r = 16 / 9;
  const a = state.settings.aspect;
  if (a === 'auto') {
    const first = state.clips[0] && media.get(state.clips[0].mediaId);
    if (first && first.width && first.height) {
      const rot = state.clips[0].rotate % 180 !== 0;
      r = rot ? first.height / first.width : first.width / first.height;
    }
  } else {
    const [w, hh] = a.split(':').map(Number);
    r = w / hh;
  }
  const q = state.settings.quality;
  let W, H;
  if (r >= 1) { H = q; W = q * r; } else { W = q; H = q / r; }
  return { W: Math.round(W / 2) * 2, H: Math.round(H / 2) * 2 };
}
function resizeCanvas() {
  const { W, H } = outputSize();
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; fitCanvas(); }
}
// Size the on-screen canvas to fit the stage while keeping its aspect ratio.
const stage = $('#stage');
function fitCanvas() {
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (aw <= 0 || ah <= 0) return;
  const s = Math.min(aw / canvas.width, ah / canvas.height);
  canvas.style.width = `${Math.floor(canvas.width * s)}px`;
  canvas.style.height = `${Math.floor(canvas.height * s)}px`;
}
new ResizeObserver(fitCanvas).observe(stage);
function filterString(f, W) {
  const parts = [];
  if (f.brightness !== 100) parts.push(`brightness(${f.brightness}%)`);
  if (f.contrast !== 100) parts.push(`contrast(${f.contrast}%)`);
  if (f.saturate !== 100) parts.push(`saturate(${f.saturate}%)`);
  if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
  if (f.grayscale) parts.push(`grayscale(${f.grayscale}%)`);
  if (f.sepia) parts.push(`sepia(${f.sepia}%)`);
  if (f.blur) parts.push(`blur(${(f.blur * W / 1000).toFixed(2)}px)`);
  return parts.join(' ') || 'none';
}
function drawVideo(el, c, mode, W, H, zoom) {
  const vw = el.videoWidth, vh = el.videoHeight;
  if (!vw || !vh) return;
  const rot = (((c.rotate || 0) % 360) + 360) % 360;
  const sideways = rot % 180 !== 0;
  const rw = sideways ? vh : vw, rh = sideways ? vw : vh;
  const scale = (mode === 'cover' ? Math.max(W / rw, H / rh) : Math.min(W / rw, H / rh)) * zoom;
  const dw = rw * scale, dh = rh * scale;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((rot * Math.PI) / 180);
  if (c.flip) ctx.scale(-1, 1);
  const iw = sideways ? dh : dw, ih = sideways ? dw : dh;
  ctx.drawImage(el, -iw / 2, -ih / 2, iw, ih);
  ctx.restore();
}

function draw() {
  resizeCanvas();
  const W = canvas.width, H = canvas.height;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = state.settings.bg;
  ctx.fillRect(0, 0, W, H);
  const seg = activeSeg() || segAt(player.t);
  if (seg && seg.media.el.readyState >= 2) {
    const c = seg.clip;
    const el = seg.media.el;
    ctx.globalAlpha = fadeAlpha(c, player.t - seg.start, seg.dur);
    const fit = state.settings.fit;
    if (fit === 'blur') {
      ctx.filter = `blur(${Math.round(Math.max(W, H) / 45)}px) brightness(60%)`;
      drawVideo(el, c, 'cover', W, H, 1.08);
    }
    ctx.filter = filterString(c.filters, W);
    drawVideo(el, c, fit === 'cover' ? 'cover' : 'contain', W, H, c.zoom || 1);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
  }
  textBoxes.clear();
  for (const tx of state.texts) {
    if (player.t >= tx.start && player.t <= tx.end) drawText(tx, W, H, player.t);
  }
  const st = selectedText();
  if (st && !player.exporting && textBoxes.has(st.id)) {
    const b = textBoxes.get(st.id);
    ctx.setLineDash([Math.max(4, W / 160), Math.max(4, W / 160)]);
    ctx.lineWidth = Math.max(1.5, W / 640);
    ctx.strokeStyle = '#a28bff';
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeBack = (p) => 1 + 2.7 * Math.pow(p - 1, 3) + 1.7 * Math.pow(p - 1, 2);

function drawText(tx, W, H, t) {
  const px = Math.max(6, Math.round((tx.size / 100) * H));
  ctx.font = `${tx.bold ? 700 : 400} ${px}px ${FONTS[tx.font]?.css || FONTS.sans.css}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let text = tx.text;
  const animDur = 0.35;
  const p = Math.min(clamp((t - tx.start) / animDur, 0, 1), clamp((tx.end - t) / animDur, 0, 1));
  let alpha = 1, scale = 1, dy = 0;
  switch (tx.anim) {
    case 'fade': alpha = p; break;
    case 'pop': alpha = p; scale = 0.5 + 0.5 * easeBack(p); break;
    case 'slide': alpha = p; dy = (1 - easeOut(p)) * H * 0.06; break;
    case 'type': {
      const n = Math.floor((t - tx.start) * 18);
      text = text.slice(0, Math.max(0, n));
      alpha = clamp((tx.end - t) / animDur, 0, 1);
      break;
    }
    default: break;
  }
  const full = tx.text.split('\n');
  const lines = text.split('\n');
  const lh = px * 1.2;
  const bw = Math.max(1, ...full.map((l) => ctx.measureText(l).width));
  const bh = lh * full.length;
  const pad = px * 0.35;
  const cx = tx.x * W, cy = tx.y * H;
  textBoxes.set(tx.id, { x: cx - bw / 2 - pad, y: cy - bh / 2 - pad, w: bw + pad * 2, h: bh + pad * 2 });

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy + dy);
  ctx.scale(scale, scale);
  if (tx.bg) {
    ctx.fillStyle = hexToRgba(tx.bgColor, tx.bgOpacity);
    const r = px * 0.25;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-bw / 2 - pad, -bh / 2 - pad, bw + pad * 2, bh + pad * 2, r);
    else ctx.rect(-bw / 2 - pad, -bh / 2 - pad, bw + pad * 2, bh + pad * 2);
    ctx.fill();
  }
  if (!tx.bg && !tx.outline) {
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = px * 0.15;
    ctx.shadowOffsetY = px * 0.04;
  }
  lines.forEach((line, i) => {
    const y = -bh / 2 + lh * (i + 0.5);
    if (tx.outline) {
      ctx.lineWidth = Math.max(2, px * 0.14);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = tx.outlineColor || '#000000';
      ctx.strokeText(line, 0, y);
    }
    ctx.fillStyle = tx.color;
    ctx.fillText(line, 0, y);
  });
  ctx.restore();
}

/* ======================================================================
 * Media import
 * ==================================================================== */
const host = $('#media-host');

function kindOf(file) {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (/\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i.test(file.name)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i.test(file.name)) return 'audio';
  return null;
}

async function fixDuration(el) {
  if (Number.isFinite(el.duration)) return;
  // MediaRecorder-made WebM files report Infinity until you seek to the end.
  await new Promise((res) => {
    const onChange = () => { if (Number.isFinite(el.duration)) { el.removeEventListener('durationchange', onChange); res(); } };
    el.addEventListener('durationchange', onChange);
    el.currentTime = 1e101;
    setTimeout(res, 4000);
  });
  el.currentTime = 0;
}

async function importFiles(fileList) {
  const files = [...fileList];
  let addedVideo = false;
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) { toast(`Skipped ${file.name}: not a video or audio file`); continue; }
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind);
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.src = url;
    host.appendChild(el);
    try {
      await once(el, 'loadedmetadata');
      await fixDuration(el);
      if (kind === 'video') {
        if (!el.videoWidth) throw new Error('no video track');
        if (el.readyState < 2) await once(el, 'loadeddata', 3000);
      }
    } catch (e) {
      console.warn(e);
      toast(`Can't open ${file.name} in this browser (unsupported codec?)`, 4000);
      el.remove();
      URL.revokeObjectURL(url);
      continue;
    }
    const m = {
      id: uid(), name: file.name, kind, url, el,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      width: el.videoWidth || 0, height: el.videoHeight || 0, thumb: null, strip: null,
    };
    media.set(m.id, m);
    connectMedia(m);
    if (kind === 'video') {
      addClip(m.id);
      addedVideo = true;
      makeFilmstrip(m);
    } else if (!state.music) {
      setMusic(m.id);
      toast(`Added “${file.name}” as background music`);
    }
    renderMedia();
  }
  commit();
  if (addedVideo) seekTo(player.t);
}

async function makeFilmstrip(m) {
  // Use a separate element so playback is never disturbed.
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = m.url;
  host.appendChild(v);
  try {
    await once(v, 'loadeddata', 4000);
    await fixDuration(v);
    const N = 10, th = 54;
    const tw = Math.round(th * (m.width / m.height)) || 96;
    const c = document.createElement('canvas');
    c.width = tw * N; c.height = th;
    const cx = c.getContext('2d');
    for (let i = 0; i < N; i++) {
      await seekEl(v, Math.min(m.duration - 0.05, (m.duration * (i + 0.5)) / N));
      cx.drawImage(v, i * tw, 0, tw, th);
      if (i === 1) { m.thumb = c.toDataURL('image/jpeg', 0.7); renderMedia(); }
    }
    m.strip = c.toDataURL('image/jpeg', 0.7);
    // a nicer single thumbnail from the middle tile
    const t = document.createElement('canvas');
    t.width = tw; t.height = th;
    t.getContext('2d').drawImage(c, Math.floor(N / 2) * tw, 0, tw, th, 0, 0, tw, th);
    m.thumb = t.toDataURL('image/jpeg', 0.75);
  } catch (e) { console.warn('filmstrip failed', e); }
  v.remove();
  renderMedia();
  renderTimeline();
}

function addClip(mediaId, index = state.clips.length) {
  const m = media.get(mediaId);
  const c = {
    id: uid(), mediaId, in: 0, out: m.duration, speed: 1, volume: 1, muted: false,
    fadeIn: 0, fadeOut: 0, rotate: 0, flip: false, zoom: 1, filters: { ...DEFAULT_FILTERS }, preset: 'none',
  };
  state.clips.splice(index, 0, c);
  return c;
}
function setMusic(mediaId) {
  state.music = { mediaId, volume: 0.6, offset: 0, fadeIn: 0, fadeOut: 2, loop: false };
}
function removeMedia(id) {
  const m = media.get(id);
  if (!m) return;
  const used = state.clips.some((c) => c.mediaId === id) || state.music?.mediaId === id;
  // Two-tap confirmation (native confirm() dialogs are blocked in some embeds).
  if (used && removeMedia.armed !== id) {
    removeMedia.armed = id;
    clearTimeout(removeMedia.timer);
    removeMedia.timer = setTimeout(() => { removeMedia.armed = null; }, 4000);
    toast(`Tap ✕ again to remove “${m.name}” and its clips`, 4000);
    return;
  }
  removeMedia.armed = null;
  pause();
  state.clips = state.clips.filter((c) => c.mediaId !== id);
  if (state.music?.mediaId === id) state.music = null;
  media.delete(id);
  m.el.pause();
  m.el.remove();
  URL.revokeObjectURL(m.url);
  // Undo snapshots can no longer reference this media.
  history.stack = [];
  history.idx = -1;
  commit();
  seekTo(player.t);
}

/* ======================================================================
 * Editing actions
 * ==================================================================== */
function select(kind, id) {
  selection = { kind, id };
  if (kind === 'clip') activeTab = 'clip';
  if (kind === 'text') activeTab = 'text';
  renderTabs();
  renderInspector();
  renderTimeline();
  draw();
}

function splitAtPlayhead() {
  const seg = segAt(player.t);
  if (!seg) return;
  const c = seg.clip;
  const src = c.in + (player.t - seg.start) * c.speed;
  if (src - c.in < 0.05 || c.out - src < 0.05) { toast('Move the playhead inside a clip to split it'); return; }
  pause();
  const c2 = { ...clone(c), id: uid(), in: src, fadeIn: 0 };
  c.out = src;
  c.fadeOut = 0;
  state.clips.splice(state.clips.indexOf(c) + 1, 0, c2);
  selection = { kind: 'clip', id: c2.id };
  commit();
  seekTo(player.t);
}

function deleteSelected() {
  if (selection.kind === 'clip') {
    pause();
    state.clips = state.clips.filter((c) => c.id !== selection.id);
  } else if (selection.kind === 'text') {
    state.texts = state.texts.filter((t) => t.id !== selection.id);
  } else return;
  selection = { kind: null, id: null };
  commit();
  seekTo(player.t);
}

function duplicateClip(c) {
  const c2 = { ...clone(c), id: uid() };
  state.clips.splice(state.clips.indexOf(c) + 1, 0, c2);
  selection = { kind: 'clip', id: c2.id };
  commit();
}
function moveClip(c, dir) {
  const i = state.clips.indexOf(c);
  const j = i + dir;
  if (j < 0 || j >= state.clips.length) return;
  pause();
  state.clips.splice(i, 1);
  state.clips.splice(j, 0, c);
  commit();
  seekTo(player.t);
}
function trimToPlayhead(c, edge) {
  const seg = segById(c.id);
  if (!seg) return;
  if (player.t < seg.start || player.t > seg.start + seg.dur) { toast('Put the playhead inside this clip first'); return; }
  const src = c.in + (player.t - seg.start) * c.speed;
  if (edge === 'in') c.in = Math.min(src, c.out - 0.1);
  else c.out = Math.max(src, c.in + 0.1);
  pause();
  commit();
  const s2 = segById(c.id);
  seekTo(edge === 'in' ? s2.start : s2.start + s2.dur - 0.001);
}

function addText() {
  const T = totalDuration();
  const start = T ? Math.min(player.t, Math.max(0, T - 0.5)) : 0;
  const tx = {
    id: uid(), text: 'Your text here', start, end: Math.min(start + 3, Math.max(T, start + 1)),
    x: 0.5, y: 0.82, size: 7, color: '#ffffff', font: 'sans', bold: true,
    outline: false, outlineColor: '#000000', bg: true, bgColor: '#000000', bgOpacity: 0.5, anim: 'fade',
  };
  state.texts.push(tx);
  selection = { kind: 'text', id: tx.id };
  activeTab = 'text';
  commit();
  draw();
  setTimeout(() => { const ta = $('#inspector-body textarea'); if (ta) { ta.focus(); ta.select(); } }, 0);
}

/* ======================================================================
 * Inspector UI
 * ==================================================================== */
const body = $('#inspector-body');

function section(title, ...kids) { return h('div', { class: 'section' }, h('h4', {}, title), ...kids); }
function slider({ label, value, min, max, step = 1, unit = '', fmtv, onInput, onCommit }) {
  const show = (v) => (fmtv ? fmtv(v) : `${Math.round(v * 100) / 100}${unit}`);
  const out = h('span', { class: 'val' }, show(value));
  const inp = h('input', { type: 'range', min, max, step });
  inp.value = value;
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); out.textContent = show(v); onInput(v); });
  inp.addEventListener('change', () => { if (onCommit) onCommit(); commit(); });
  return h('label', { class: 'ctl' }, h('div', { class: 'ctl-head' }, h('span', {}, label), out), inp);
}
function selectCtl({ label, options, value, onChange }) {
  const s = h('select', {}, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = String(value);
  s.addEventListener('change', () => { onChange(s.value); commit(); });
  return h('label', { class: 'ctl' }, label, s);
}
function check({ label, checked, onChange }) {
  const i = h('input', { type: 'checkbox' });
  i.checked = !!checked;
  i.addEventListener('change', () => { onChange(i.checked); commit(); draw(); });
  return h('label', { class: 'check' }, i, label);
}
function color({ label, value, onInput }) {
  const i = h('input', { type: 'color' });
  i.value = value;
  i.addEventListener('input', () => { onInput(i.value); draw(); });
  i.addEventListener('change', commit);
  return h('label', { class: 'check' }, i, label);
}
const btn = (label, onclick, cls = '') => h('button', { class: `btn small ${cls}`, type: 'button', onclick }, label);

function clipPanel() {
  const c = selectedClip();
  if (!c) {
    return [h('p', { class: 'hint' }, state.clips.length
      ? 'Click a clip on the timeline to trim it, change speed, add filters and more.'
      : 'Import a video to get started.')];
  }
  const m = media.get(c.mediaId);
  const live = () => { renderTimeline(); draw(); updateTimeUI(); };
  const showEdge = (edge) => {
    const s = segById(c.id);
    if (s) seekTo(edge === 'in' ? s.start : s.start + s.dur - 0.001, false);
    renderTimeline();
  };
  const filterSliders = FILTER_CTLS.map(([k, label, min, max, unit]) => slider({
    label, value: c.filters[k], min, max, unit,
    onInput: (v) => { c.filters[k] = v; c.preset = 'custom'; draw(); },
  }));
  return [
    h('div', { class: 'insp-title' }, m.name),
    h('div', { class: 'hint small' }, `Source ${fmt(m.duration)} · ${m.width}×${m.height} · on timeline ${fmt((c.out - c.in) / c.speed)}`),
    section('Trim',
      slider({ label: 'Start', value: c.in, min: 0, max: m.duration, step: 0.01, fmtv: fmt,
        onInput: (v) => { c.in = Math.min(v, c.out - 0.1); showEdge('in'); } }),
      slider({ label: 'End', value: c.out, min: 0, max: m.duration, step: 0.01, fmtv: fmt,
        onInput: (v) => { c.out = Math.max(v, c.in + 0.1); showEdge('out'); } }),
      h('div', { class: 'row' }, btn('Start at playhead', () => trimToPlayhead(c, 'in')), btn('End at playhead', () => trimToPlayhead(c, 'out'))),
    ),
    section('Speed & sound',
      selectCtl({ label: 'Speed', value: c.speed, options: SPEEDS.map((s) => [s, `${s}×`]),
        onChange: (v) => { pause(); c.speed = parseFloat(v); live(); } }),
      slider({ label: 'Volume', value: Math.round(c.volume * 100), min: 0, max: 200, unit: '%',
        onInput: (v) => { c.volume = v / 100; } }),
      check({ label: 'Mute this clip', checked: c.muted, onChange: (v) => { c.muted = v; } }),
    ),
    section('Fades',
      slider({ label: 'Fade in', value: c.fadeIn, min: 0, max: 3, step: 0.1, unit: 's', onInput: (v) => { c.fadeIn = v; draw(); } }),
      slider({ label: 'Fade out', value: c.fadeOut, min: 0, max: 3, step: 0.1, unit: 's', onInput: (v) => { c.fadeOut = v; draw(); } }),
    ),
    section('Frame',
      h('div', { class: 'row' },
        btn('⟲ Rotate left', () => { c.rotate = (c.rotate + 270) % 360; commit(); draw(); }),
        btn('Rotate right ⟳', () => { c.rotate = (c.rotate + 90) % 360; commit(); draw(); })),
      check({ label: 'Flip horizontally (mirror)', checked: c.flip, onChange: (v) => { c.flip = v; } }),
      slider({ label: 'Zoom', value: Math.round((c.zoom || 1) * 100), min: 100, max: 300, unit: '%', onInput: (v) => { c.zoom = v / 100; draw(); } }),
    ),
    section('Look',
      h('div', { class: 'chips' }, Object.entries(PRESETS).map(([k, p]) => h('button', {
        class: `chip ${c.preset === k ? 'active' : ''}`, type: 'button',
        onclick: () => { c.filters = { ...DEFAULT_FILTERS, ...Object.fromEntries(Object.entries(p).filter(([kk]) => kk !== 'label')) }; c.preset = k; commit(); draw(); },
      }, p.label))),
      ...filterSliders,
      h('div', { class: 'row' },
        btn('Apply look to all clips', () => { for (const o of state.clips) { o.filters = { ...c.filters }; o.preset = c.preset; } commit(); toast('Look applied to all clips'); }),
        btn('Reset', () => { c.filters = { ...DEFAULT_FILTERS }; c.preset = 'none'; commit(); draw(); })),
    ),
    section('Arrange',
      h('div', { class: 'row' }, btn('← Move', () => moveClip(c, -1)), btn('Move →', () => moveClip(c, 1)), btn('Duplicate', () => duplicateClip(c))),
      h('div', { class: 'row' }, btn('Split at playhead', splitAtPlayhead), btn('Delete clip', deleteSelected, 'danger')),
    ),
  ];
}

function textPanel() {
  const out = [h('button', { class: 'btn primary block', type: 'button', onclick: addText }, '+ Add text at playhead')];
  const tx = selectedText();
  if (state.texts.length) {
    out.push(h('div', {}, state.texts.map((t) => h('button', {
      class: `list-item ${tx && tx.id === t.id ? 'active' : ''}`, type: 'button',
      onclick: () => { select('text', t.id); seekTo(t.start + 0.05, false); },
    }, h('span', {}, t.text.split('\n')[0] || '(empty)'), h('small', {}, `${fmt(t.start)}–${fmt(t.end)}`)))));
  }
  if (!tx) {
    out.push(h('p', { class: 'hint' }, 'Add titles and captions. Drag text directly on the preview to position it.'));
    return out;
  }
  const ta = h('textarea', { rows: 3 });
  ta.value = tx.text;
  ta.addEventListener('input', () => { tx.text = ta.value; draw(); renderTimeline(); });
  ta.addEventListener('change', commit);
  const num = (label, key) => {
    const i = h('input', { type: 'number', min: 0, step: 0.1 });
    i.value = tx[key].toFixed(2);
    i.addEventListener('change', () => {
      const v = Math.max(0, parseFloat(i.value) || 0);
      if (key === 'start') { tx.start = Math.min(v, tx.end - 0.1); } else { tx.end = Math.max(v, tx.start + 0.1); }
      commit(); draw();
    });
    return h('label', { class: 'ctl' }, label, i);
  };
  const pos = (label, x, y) => btn(label, () => { tx.x = x; tx.y = y; commit(); draw(); });
  out.push(
    section('Edit text',
      h('label', { class: 'ctl' }, ta),
      selectCtl({ label: 'Font', value: tx.font, options: Object.entries(FONTS).map(([k, f]) => [k, f.label]), onChange: (v) => { tx.font = v; draw(); } }),
      slider({ label: 'Size', value: tx.size, min: 2, max: 25, step: 0.5, unit: '%', onInput: (v) => { tx.size = v; draw(); } }),
      check({ label: 'Bold', checked: tx.bold, onChange: (v) => { tx.bold = v; } }),
      h('div', { class: 'row' },
        color({ label: 'Text', value: tx.color, onInput: (v) => { tx.color = v; } }),
        color({ label: 'Outline', value: tx.outlineColor || '#000000', onInput: (v) => { tx.outlineColor = v; } }),
        color({ label: 'Box', value: tx.bgColor, onInput: (v) => { tx.bgColor = v; } })),
      check({ label: 'Outline', checked: tx.outline, onChange: (v) => { tx.outline = v; } }),
      check({ label: 'Background box', checked: tx.bg, onChange: (v) => { tx.bg = v; } }),
      tx.bg ? slider({ label: 'Box opacity', value: Math.round(tx.bgOpacity * 100), min: 0, max: 100, unit: '%', onInput: (v) => { tx.bgOpacity = v / 100; draw(); } }) : null,
    ),
    section('Position',
      h('div', { class: 'row' }, pos('Top', 0.5, 0.12), pos('Middle', 0.5, 0.5), pos('Bottom', 0.5, 0.82)),
      h('p', { class: 'hint small' }, 'Tip: drag the text on the preview to place it anywhere.'),
    ),
    section('Timing',
      h('div', { class: 'grid2' }, num('Start (s)', 'start'), num('End (s)', 'end')),
      h('div', { class: 'row' },
        btn('Start at playhead', () => { tx.start = Math.min(player.t, tx.end - 0.1); commit(); draw(); }),
        btn('End at playhead', () => { tx.end = Math.max(player.t, tx.start + 0.1); commit(); draw(); })),
      selectCtl({ label: 'Animation', value: tx.anim, options: [['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['slide', 'Slide up'], ['type', 'Typewriter']], onChange: (v) => { tx.anim = v; draw(); } }),
    ),
    section('Actions',
      h('div', { class: 'row' },
        btn('Duplicate', () => { const t2 = { ...clone(tx), id: uid(), start: tx.end, end: tx.end + (tx.end - tx.start) }; state.texts.push(t2); selection.id = t2.id; commit(); }),
        btn('Delete text', deleteSelected, 'danger')),
    ),
  );
  return out;
}

function musicPanel() {
  const out = [];
  const mu = state.music;
  const audios = [...media.values()].filter((m) => m.kind === 'audio');
  if (!mu) {
    out.push(
      h('p', { class: 'hint' }, 'Add a song or voice-over that plays under your video.'),
      h('button', { class: 'btn primary block', type: 'button', onclick: () => $('#music-input').click() }, 'Choose audio file'),
    );
    if (audios.length) {
      out.push(section('Imported audio', ...audios.map((m) => h('div', { class: 'row' },
        h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.name),
        btn('Use', () => { setMusic(m.id); commit(); })))));
    }
  } else {
    const m = media.get(mu.mediaId);
    out.push(
      h('div', { class: 'insp-title' }, `♪ ${m ? m.name : 'Missing audio'}`),
      h('div', { class: 'hint small' }, m ? `Length ${fmt(m.duration)}` : ''),
      section('Mix',
        slider({ label: 'Music volume', value: Math.round(mu.volume * 100), min: 0, max: 150, unit: '%', onInput: (v) => { mu.volume = v / 100; } }),
        h('div', { class: 'row' },
          btn('Mute all clip audio', () => { state.clips.forEach((c) => { c.muted = true; }); commit(); toast('Original clip audio muted'); }),
          btn('Unmute all', () => { state.clips.forEach((c) => { c.muted = false; }); commit(); })),
      ),
      section('Timing',
        slider({ label: 'Start song at', value: mu.offset, min: 0, max: m ? Math.max(0, m.duration - 1) : 0, step: 0.1, fmtv: fmt, onInput: (v) => { mu.offset = v; } }),
        slider({ label: 'Fade in', value: mu.fadeIn, min: 0, max: 5, step: 0.1, unit: 's', onInput: (v) => { mu.fadeIn = v; } }),
        slider({ label: 'Fade out at end', value: mu.fadeOut, min: 0, max: 8, step: 0.1, unit: 's', onInput: (v) => { mu.fadeOut = v; } }),
        check({ label: 'Loop if the song is shorter than the video', checked: mu.loop, onChange: (v) => { mu.loop = v; } }),
      ),
      h('div', { class: 'row' },
        btn('Replace…', () => $('#music-input').click()),
        btn('Remove music', () => { pause(); if (m) m.el.pause(); state.music = null; commit(); }, 'danger')),
    );
  }
  return out;
}

function projectPanel() {
  const { W, H } = outputSize();
  const T = totalDuration();
  return [
    section('Format',
      selectCtl({ label: 'Aspect ratio', value: state.settings.aspect, options: ASPECTS, onChange: (v) => { state.settings.aspect = v; draw(); } }),
      selectCtl({ label: 'Resolution', value: state.settings.quality, options: [[480, '480p'], [720, '720p HD'], [1080, '1080p Full HD']], onChange: (v) => { state.settings.quality = parseInt(v, 10); draw(); } }),
      selectCtl({ label: 'When the video doesn’t fit', value: state.settings.fit, options: [['contain', 'Show whole frame (bars)'], ['blur', 'Blurred background'], ['cover', 'Crop to fill']], onChange: (v) => { state.settings.fit = v; draw(); } }),
      color({ label: 'Bar / background colour', value: state.settings.bg, onInput: (v) => { state.settings.bg = v; } }),
    ),
    section('Summary',
      h('dl', { class: 'kv' },
        h('dt', {}, 'Output size'), h('dd', {}, `${W} × ${H}`),
        h('dt', {}, 'Duration'), h('dd', {}, fmt(T)),
        h('dt', {}, 'Clips'), h('dd', {}, String(state.clips.length)),
        h('dt', {}, 'Text layers'), h('dd', {}, String(state.texts.length)),
        h('dt', {}, 'Music'), h('dd', {}, state.music ? 'Yes' : 'No'))),
    section('Keyboard shortcuts',
      h('dl', { class: 'kv small' },
        h('dt', {}, 'Space'), h('dd', {}, 'Play / pause'),
        h('dt', {}, '← / →'), h('dd', {}, 'Step 1 frame (Shift: 1s)'),
        h('dt', {}, 'S'), h('dd', {}, 'Split at playhead'),
        h('dt', {}, 'T'), h('dd', {}, 'Add text'),
        h('dt', {}, 'Delete'), h('dd', {}, 'Delete selection'),
        h('dt', {}, 'Ctrl+Z / Ctrl+Shift+Z'), h('dd', {}, 'Undo / redo'),
        h('dt', {}, 'Home / End'), h('dd', {}, 'Jump to start / end'))),
  ];
}

function renderTabs() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
}
function renderInspector() {
  const scroll = body.scrollTop;
  const panels = { clip: clipPanel, text: textPanel, music: musicPanel, project: projectPanel };
  body.replaceChildren(...panels[activeTab]());
  body.scrollTop = scroll;
}

/* ======================================================================
 * Media list UI
 * ==================================================================== */
function renderMedia() {
  const list = $('#media-list');
  if (!media.size) { list.replaceChildren(h('p', { class: 'hint small', style: { margin: '0 4px' } }, 'No media yet.')); return; }
  list.replaceChildren(...[...media.values()].map((m) => h('div', { class: 'media-item' },
    h('div', { class: 'media-thumb', style: m.thumb ? { backgroundImage: `url(${m.thumb})` } : {} }, m.kind === 'audio' ? '♪' : ''),
    h('div', { class: 'media-meta' },
      h('div', { class: 'media-name', title: m.name }, m.name),
      h('div', { class: 'media-sub' },
        h('span', {}, fmt(m.duration)),
        m.kind === 'video'
          ? h('button', { type: 'button', onclick: () => { addClip(m.id); commit(); seekTo(player.t); toast('Added to end of timeline'); } }, '+ Add')
          : h('button', { type: 'button', onclick: () => { setMusic(m.id); activeTab = 'music'; renderTabs(); commit(); } }, 'Use as music'),
        h('button', { type: 'button', class: 'rm', title: 'Remove', 'aria-label': `Remove ${m.name}`, onclick: () => removeMedia(m.id) }, '✕'))))));
}

/* ======================================================================
 * Timeline UI
 * ==================================================================== */
const tlScroll = $('#tl-scroll');
const tlInner = $('#tl-inner');
const ruler = $('#ruler');
const trackVideo = $('#track-video');
const trackText = $('#track-text');
const trackMusic = $('#track-music');
const playheadEl = $('#playhead');

function timelineSpan() {
  const T = totalDuration();
  const textEnd = state.texts.reduce((a, t) => Math.max(a, t.end), 0);
  return Math.max(T, textEnd, 5);
}
function renderTimeline() {
  const segs = segments();
  const span = timelineSpan();
  const viewW = tlScroll.clientWidth || 600;
  pps = ((viewW - 30) / span) * zoomMult;
  tlInner.style.width = `${Math.max(viewW, span * pps + 30)}px`;

  // Ruler
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const stepS = steps.find((s) => s * pps >= 70) || 600;
  const ticks = [];
  for (let t = 0; t <= span + stepS; t += stepS) {
    ticks.push(h('div', { class: 'tick', style: { left: `${t * pps}px` } }, fmtShort(t, stepS)));
    const half = t + stepS / 2;
    ticks.push(h('div', { class: 'tick minor', style: { left: `${half * pps}px` } }));
  }
  ruler.replaceChildren(...ticks);

  // Video track
  trackVideo.replaceChildren(...segs.map((s) => {
    const c = s.clip, m = s.media;
    const w = Math.max(4, s.dur * pps);
    const style = { left: `${s.start * pps}px`, width: `${w}px` };
    if (m.strip) {
      const full = (m.duration / (c.out - c.in)) * w;
      Object.assign(style, {
        backgroundImage: `url(${m.strip})`, backgroundSize: `${full}px 100%`,
        backgroundPosition: `${-(c.in / m.duration) * full}px 0`,
      });
    }
    const badges = [c.speed !== 1 ? `${c.speed}×` : '', c.muted ? '🔇' : '', c.preset !== 'none' ? '🎨' : ''].filter(Boolean).join(' ');
    return h('div', { class: `blk clip ${selection.id === c.id ? 'sel' : ''}`, 'data-kind': 'clip', 'data-id': c.id, style, title: m.name },
      h('div', { class: 'handle l', 'data-handle': 'l' }),
      h('span', { class: 'lab' }, `${badges} ${m.name} · ${s.dur.toFixed(1)}s`),
      h('div', { class: 'handle r', 'data-handle': 'r' }));
  }));

  // Text track
  trackText.replaceChildren(...state.texts.map((t) => h('div', {
    class: `blk text ${selection.id === t.id ? 'sel' : ''}`, 'data-kind': 'text', 'data-id': t.id,
    style: { left: `${t.start * pps}px`, width: `${Math.max(4, (t.end - t.start) * pps)}px` },
  }, h('div', { class: 'handle l', 'data-handle': 'l' }), h('span', { class: 'lab' }, `T ${t.text.split('\n')[0]}`), h('div', { class: 'handle r', 'data-handle': 'r' }))));

  // Music track
  const mu = state.music;
  const mm = mu && media.get(mu.mediaId);
  if (mm) {
    const T = totalDuration();
    const len = mu.loop ? T : Math.min(T, Math.max(0, mm.duration - mu.offset));
    trackMusic.replaceChildren(h('div', {
      class: 'blk music', 'data-kind': 'music', style: { left: '0px', width: `${Math.max(40, len * pps)}px` },
    }, h('span', { class: 'lab' }, `♪ ${mm.name}`)));
  } else trackMusic.replaceChildren();

  updateTimeUI();
}

function updateTimeUI(follow = false) {
  const T = totalDuration();
  $('#time').textContent = `${fmt(player.t)} / ${fmt(T)}`;
  const x = player.t * pps;
  playheadEl.style.left = `${x}px`;
  if (follow) {
    const { scrollLeft, clientWidth } = tlScroll;
    if (x > scrollLeft + clientWidth - 40 || x < scrollLeft) tlScroll.scrollLeft = Math.max(0, x - 40);
  }
}

// --- Timeline pointer interactions: scrub, select, drag-to-reorder, trim handles
let drag = null;
const tlTimeAt = (clientX) => (clientX - tlInner.getBoundingClientRect().left) / pps;

tlInner.addEventListener('pointerdown', (e) => {
  if (player.exporting || e.button > 0) return;
  const blk = e.target.closest('.blk');
  if (!blk || blk.dataset.kind === 'music') {
    // Scrub
    drag = { kind: 'scrub' };
    if (blk) { activeTab = 'music'; renderTabs(); renderInspector(); }
    seekTo(tlTimeAt(e.clientX));
    return;
  }
  const { kind, id } = blk.dataset;
  const handle = e.target.dataset.handle || 'move';
  if (selection.id !== id) select(kind, id);
  const obj = kind === 'clip' ? state.clips.find((c) => c.id === id) : state.texts.find((t) => t.id === id);
  drag = { kind, id, handle, x0: e.clientX, moved: false, orig: clone(obj), obj, wasPlaying: player.playing };
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'scrub') { seekTo(tlTimeAt(e.clientX), false); return; }
  const dx = e.clientX - drag.x0;
  if (!drag.moved && Math.abs(dx) < 4) return;
  if (!drag.moved) { drag.moved = true; pause(); }
  const dt = dx / pps;
  const { obj, orig, handle } = drag;
  if (drag.kind === 'clip') {
    const m = media.get(obj.mediaId);
    if (handle === 'l') {
      obj.in = clamp(orig.in + dt * obj.speed, 0, orig.out - 0.1);
      renderTimeline();
      const s = segById(obj.id); seekTo(s.start, false);
    } else if (handle === 'r') {
      obj.out = clamp(orig.out + dt * obj.speed, orig.in + 0.1, m.duration);
      renderTimeline();
      const s = segById(obj.id); seekTo(s.start + s.dur - 0.001, false);
    } else {
      const el = trackVideo.querySelector(`[data-id="${obj.id}"]`);
      if (el) { el.style.transform = `translateX(${dx}px)`; el.classList.add('dragging'); }
    }
  } else if (drag.kind === 'text') {
    const len = orig.end - orig.start;
    if (handle === 'l') obj.start = clamp(orig.start + dt, 0, orig.end - 0.1);
    else if (handle === 'r') obj.end = Math.max(orig.start + 0.1, orig.end + dt);
    else { obj.start = Math.max(0, orig.start + dt); obj.end = obj.start + len; }
    renderTimeline();
    draw();
  }
});

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'scrub') return;
  if (!d.moved) {
    // simple click: move the playhead there too
    seekTo(tlTimeAt(e.clientX));
    return;
  }
  if (d.kind === 'clip' && d.handle === 'move') {
    const t = tlTimeAt(e.clientX);
    const others = segments().filter((s) => s.clip.id !== d.id);
    const idx = others.filter((s) => s.start + s.dur / 2 < t).length;
    state.clips = state.clips.filter((c) => c.id !== d.id);
    state.clips.splice(idx, 0, d.obj);
  }
  commit();
  seekTo(player.t);
});

tlScroll.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  zoomMult = clamp(zoomMult * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 30);
  $('#tl-zoom').value = zoomMult;
  renderTimeline();
}, { passive: false });
$('#tl-zoom').addEventListener('input', (e) => { zoomMult = parseFloat(e.target.value); renderTimeline(); updateTimeUI(true); });

// --- Drag text on the preview canvas
let textDrag = null;
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
}
function hitText(p) {
  const ids = [...textBoxes.keys()].reverse();
  return ids.find((id) => { const b = textBoxes.get(id); return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; });
}
canvas.addEventListener('pointerdown', (e) => {
  if (player.exporting) return;
  const p = canvasPoint(e);
  const id = hitText(p);
  if (!id) return;
  const tx = state.texts.find((t) => t.id === id);
  select('text', id);
  textDrag = { tx, p0: p, x0: tx.x, y0: tx.y };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  const p = canvasPoint(e);
  if (!textDrag) { canvas.style.cursor = hitText(p) ? 'move' : 'default'; return; }
  const { tx, p0, x0, y0 } = textDrag;
  tx.x = clamp(x0 + (p.x - p0.x) / canvas.width, 0, 1);
  tx.y = clamp(y0 + (p.y - p0.y) / canvas.height, 0, 1);
  // snap to centre
  if (Math.abs(tx.x - 0.5) < 0.015) tx.x = 0.5;
  draw();
});
canvas.addEventListener('pointerup', () => { if (textDrag) { textDrag = null; commit(); } });
canvas.addEventListener('dblclick', () => { if (selectedText()) { const ta = $('#inspector-body textarea'); if (ta) { ta.focus(); ta.select(); } } });

/* ======================================================================
 * Export
 * ==================================================================== */
const dlg = $('#export-dialog');
let exportCancelled = false;
let lastExportUrl = null;
let lastExport = null;

function supportedFormats() {
  if (!window.MediaRecorder) return [];
  const seen = new Set();
  return EXPORT_FORMATS.filter(([mime, label]) => {
    if (seen.has(label.split(' ')[0])) return false;
    try { if (!MediaRecorder.isTypeSupported(mime)) return false; } catch (_) { return false; }
    seen.add(label.split(' ')[0]);
    return true;
  });
}

/* MediaRecorder writes WebM files without a Duration, so players can't show a
 * length or seek properly. Insert a Duration element into the Segment Info. */
async function fixWebmDuration(blob, seconds) {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const find = (id, from, to) => {
      for (let i = from; i < Math.min(to, buf.length - id.length); i++) {
        if (id.every((b, k) => buf[i + k] === b)) return i;
      }
      return -1;
    };
    const info = find([0x15, 0x49, 0xa9, 0x66], 0, 4096);
    if (info < 0 || find([0x11, 0x4d, 0x9b, 0x74], 0, info) >= 0) return blob; // no Info, or a SeekHead we'd invalidate
    const sp = info + 4;
    const first = buf[sp];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8) return blob;
    let size = first & (0xff >> len);
    for (let i = 1; i < len; i++) size = size * 256 + buf[sp + i];
    const dataStart = sp + len;
    if (find([0x44, 0x89], dataStart, dataStart + size) >= 0) return blob; // already has a duration
    const newSize = size + 11;
    if (newSize >= 2 ** (7 * len) - 1) return blob;
    const sizeBytes = new Uint8Array(len);
    let v = newSize;
    for (let i = len - 1; i >= 0; i--) { sizeBytes[i] = v & 0xff; v = Math.floor(v / 256); }
    sizeBytes[0] |= 0x80 >> (len - 1);
    const dur = new Uint8Array(11);
    dur.set([0x44, 0x89, 0x88]);
    new DataView(dur.buffer).setFloat64(3, seconds * 1000); // TimecodeScale is 1ms in browser recordings
    return new Blob([buf.subarray(0, sp), sizeBytes, buf.subarray(dataStart, dataStart + size), dur, buf.subarray(dataStart + size)], { type: blob.type });
  } catch (e) {
    console.warn('could not patch webm duration', e);
    return blob;
  }
}

function openExport() {
  if (!state.clips.length) { toast('Add a clip first'); return; }
  pause();
  const formats = supportedFormats();
  if (!formats.length || !canvas.captureStream) { toast('Your browser can’t record video. Try Chrome, Edge or Firefox.', 4000); return; }
  $('#exp-format').replaceChildren(...formats.map(([mime, label]) => h('option', { value: mime }, label)));
  const { W, H } = outputSize();
  $('#exp-info').textContent = `${W}×${H} · 30 fps · ${fmt(totalDuration())} long`;
  $('#exp-setup').hidden = false;
  $('#exp-progress').hidden = true;
  $('#exp-done').hidden = true;
  dlg.showModal();
}

async function runExport() {
  const mime = $('#exp-format').value;
  const ext = EXPORT_FORMATS.find((f) => f[0] === mime)?.[2] || 'webm';
  const q = parseFloat($('#exp-quality').value);
  $('#exp-setup').hidden = true;
  $('#exp-progress').hidden = false;
  $('#exp-status').textContent = 'Preparing…';
  $('#exp-bar').value = 0;

  ensureAudio();
  if (actx && actx.state !== 'running') { try { await actx.resume(); } catch (_) { /* ignore */ } }
  resizeCanvas();
  const W = canvas.width, H = canvas.height, fps = 30;
  const stream = canvas.captureStream(fps);
  if (recDest) recDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(W * H * fps * q), audioBitsPerSecond: 192000 });
  } catch (e) {
    console.error(e);
    toast('Could not start the recorder in this format. Try another format.', 4000);
    stream.getVideoTracks().forEach((t) => t.stop());
    $('#exp-setup').hidden = false; $('#exp-progress').hidden = true;
    return;
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  player.exporting = true;
  exportCancelled = false;
  if (monitor && $('#exp-mute').checked) monitor.gain.value = 0;

  await seekTo(0, false);
  draw();
  const T = totalDuration();
  const ended = new Promise((r) => { player.onEnded = r; });
  rec.start(1000);
  const timer = setInterval(() => {
    $('#exp-bar').value = T ? player.t / T : 0;
    $('#exp-status').textContent = `Rendering ${fmt(player.t)} of ${fmt(T)}…`;
  }, 200);
  await play();
  await ended;
  clearInterval(timer);
  draw();
  await new Promise((r) => setTimeout(r, 250));
  rec.stop();
  await stopped;
  stream.getVideoTracks().forEach((t) => t.stop());
  player.exporting = false;
  if (monitor) monitor.gain.value = 1;
  draw();

  if (exportCancelled) { dlg.close(); toast('Export cancelled'); return; }
  let blob = new Blob(chunks, { type: mime.split(';')[0] });
  if (ext === 'webm') blob = await fixWebmDuration(blob, T);
  if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
  lastExportUrl = URL.createObjectURL(blob);
  lastExport = { blob, name: `cutline-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}` };
  $('#exp-video').src = lastExportUrl;
  $('#exp-result').textContent = `${(blob.size / 1048576).toFixed(1)} MB · ${ext.toUpperCase()} · ${W}×${H}`;
  $('#exp-progress').hidden = true;
  $('#exp-done').hidden = false;
}

function cancelExport() {
  exportCancelled = true;
  pause();
  if (player.onEnded) { const f = player.onEnded; player.onEnded = null; f(); }
}

// Save the exported file. Inside a claude.ai artifact the page can't start a
// download itself, so it asks the viewer through the `downloads` capability.
async function saveExport() {
  if (!lastExport) return;
  const downloads = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (downloads) {
    try {
      await downloads.save({ filename: lastExport.name, data: lastExport.blob });
      toast('Video saved');
    } catch (e) {
      if (e?.code === 'declined') return;
      if (e?.code === 'rate_limited') toast('A save prompt is already open. Try again in a moment.');
      else if (e?.code === 'too_large') toast('This video is too large to save here. Try “Small file” quality.', 5000);
      else toast('Saving isn’t available in this view.', 4000);
    }
    return;
  }
  const a = h('a', { href: lastExportUrl, download: lastExport.name });
  document.body.append(a);
  a.click();
  a.remove();
}

$('#btn-export').addEventListener('click', openExport);
$('#exp-download').addEventListener('click', saveExport);
$('#exp-start').addEventListener('click', runExport);
$('#exp-cancel').addEventListener('click', cancelExport);
$('#exp-close-1').addEventListener('click', () => dlg.close());
$('#exp-close-2').addEventListener('click', () => { $('#exp-video').pause(); dlg.close(); });
dlg.addEventListener('cancel', (e) => { if (player.exporting) e.preventDefault(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && player.exporting) toast('Keep this tab visible while exporting!', 5000);
});

/* ======================================================================
 * Wiring
 * ==================================================================== */
function refresh() {
  const T = totalDuration();
  if (player.t > T) player.t = T;
  $('#btn-undo').disabled = history.idx <= 0;
  $('#btn-redo').disabled = history.idx >= history.stack.length - 1;
  $('#btn-export').disabled = !state.clips.length;
  $('#empty-state').hidden = state.clips.length > 0;
  renderTimeline();
  renderInspector();
  draw();
}

const fileInput = $('#file-input');
$('#btn-import').addEventListener('click', () => fileInput.click());
$('#btn-import-2').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { importFiles(fileInput.files); fileInput.value = ''; });
$('#music-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const had = state.music;
  state.music = null;
  await importFiles([f]);
  if (!state.music) state.music = had; // import failed
  activeTab = 'music';
  renderTabs();
  commit();
});

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-play').addEventListener('click', togglePlay);
$('#btn-start').addEventListener('click', () => seekTo(0));
$('#btn-back').addEventListener('click', () => seekTo(player.t - FRAME, false));
$('#btn-fwd').addEventListener('click', () => seekTo(player.t + FRAME, false));
$('#tl-split').addEventListener('click', splitAtPlayhead);
$('#tl-delete').addEventListener('click', deleteSelected);
$('#tl-text').addEventListener('click', addText);
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  activeTab = b.dataset.tab; renderTabs(); renderInspector();
}));

// Drag & drop files anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging-files'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging-files'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging-files');
  if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (player.exporting || dlg.open) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); seekTo(player.t - (e.shiftKey ? 1 : FRAME), false); break;
    case 'ArrowRight': e.preventDefault(); seekTo(player.t + (e.shiftKey ? 1 : FRAME), false); break;
    case 'Home': seekTo(0); break;
    case 'End': seekTo(totalDuration()); break;
    case 's': case 'S': splitAtPlayhead(); break;
    case 't': case 'T': addText(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
    case 'Escape': select(null, null); break;
    default: break;
  }
});

window.addEventListener('resize', () => renderTimeline());
window.addEventListener('beforeunload', (e) => { if (state.clips.length) { e.preventDefault(); e.returnValue = ''; } });

// Boot
renderMedia();
commit();
