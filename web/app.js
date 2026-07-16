"use strict";

// ----- State ------------------------------------------------------------
const state = {
  ready: false,         // a document exists (screenshot captured or blank canvas created)
  docMode: "screenshot", // "screenshot" (measuring) | "canvas" (designing)
  background: null,     // HTMLImageElement screenshot, or null for a blank canvas
  bgColor: "#ffffff",   // fill color when there is no background image
  aiTheme: null,        // AI code-gen theme template carried by a loaded design (null = stamp canonical on export)
  drag: null,           // active pointer drag: {kind:'create'|'move'|'resize', ...}
  W: 0, H: 0,           // canvas size in true pixels
  view: { scale: 1, ox: 0, oy: 0 }, // screen = image * scale + offset
  mode: "point",        // "point" | "area"
  snap: "off",          // "off" | "90" | "45"
  grid: { on: true, spacing: 50 },
  showNumbers: true,    // draw coordinate/length labels on committed shapes
  snapPoints: true,     // snap the cursor to existing vertices/points
  eqLen: false,         // force each new segment to the first segment's length
  distInput: "",        // AutoCAD-style typed distance while drawing
  snapHit: null,        // vertex currently snapped to (for the indicator ring)
  moveSnap: null,       // live canvas element snap guides: {x?, y?}
  dropHint: null,       // live library/tree drop target + insertion slot
  shapes: [],           // committed points and areas
  selected: null,       // index into shapes — the PRIMARY selection (props/resize)
  selection: [],        // indices of all selected shapes (multi-select)
  propOpen: null,       // index of element whose properties panel is open
  editComposite: null,  // composite id whose descendants are directly selectable
  building: null,       // { pts: [...] } while drawing an area
  mouse: { sx: 0, sy: 0, ix: 0, iy: 0, over: false },
  panning: false,
  spaceDown: false,
  panStart: null,
};

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");
const coordsEl = document.getElementById("coords");
const hintEl = document.getElementById("hint");
const dpr = window.devicePixelRatio || 1;

// ----- Stable element ids (for parent/child relationships) --------------
let idCounter = 0;
const nextId = () => "el_" + (++idCounter);
const byId = (id) => state.shapes.find((s) => s.id === id);
// Give every shape an id (and keep the counter ahead of loaded ids).
function ensureIds() {
  for (const s of state.shapes) { const m = s.id && /^el_(\d+)$/.exec(s.id); if (m) idCounter = Math.max(idCounter, +m[1]); }
  for (const s of state.shapes) { if (!s.id) s.id = nextId(); }
}

// ----- Geometry helpers -------------------------------------------------
const toScreen = (tf, x, y) => ({ x: tf.ox + x * tf.scale, y: tf.oy + y * tf.scale });

function screenToImage(sx, sy) {
  return {
    x: Math.round((sx - state.view.ox) / state.view.scale),
    y: Math.round((sy - state.view.oy) / state.view.scale),
  };
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// Snap a canvas move to the visible grid and nearby element edges/centres.
// This is deliberately separate from measurement angle/point snapping.
function snapMoveDelta(indices, origins, rawDx, rawDy) {
  const moving = indices.map(i => state.shapes[i]).filter(isElement);
  if (!moving.length) return { dx: rawDx, dy: rawDy, guides: null };
  const selected = new Set(indices);
  const boxes = moving.map((s, n) => ({
    x: origins[n].x + rawDx, y: origins[n].y + rawDy, w: s.w, h: s.h,
  }));
  const box = {
    x: Math.min(...boxes.map(b => b.x)), y: Math.min(...boxes.map(b => b.y)),
    r: Math.max(...boxes.map(b => b.x + b.w)), b: Math.max(...boxes.map(b => b.y + b.h)),
  };
  const movingX = [box.x, (box.x + box.r) / 2, box.r];
  const movingY = [box.y, (box.y + box.b) / 2, box.b];
  const targetX = [], targetY = [];
  for (let i = 0; i < state.shapes.length; i++) {
    const s = state.shapes[i];
    if (selected.has(i) || !isElement(s)) continue;
    targetX.push(s.x, s.x + s.w / 2, s.x + s.w);
    targetY.push(s.y, s.y + s.h / 2, s.y + s.h);
  }
  if (state.grid.on) {
    const sp = Math.max(2, state.grid.spacing || 50);
    for (const x of movingX) targetX.push(Math.round(x / sp) * sp);
    for (const y of movingY) targetY.push(Math.round(y / sp) * sp);
  }
  const tol = 8 / state.view.scale;
  const best = (movingVals, targets) => {
    let hit = null, distance = tol;
    for (const a of movingVals) for (const t of targets) {
      const d = Math.abs(t - a);
      if (d <= distance) { distance = d; hit = { delta: t - a, guide: t }; }
    }
    return hit;
  };
  const sx = best(movingX, targetX), sy = best(movingY, targetY);
  return {
    dx: rawDx + (sx?.delta || 0), dy: rawDy + (sy?.delta || 0),
    guides: sx || sy ? { x: sx?.guide, y: sy?.guide } : null,
  };
}

// Apply the active snap constraint to `cur` relative to anchor `last`.
function applySnap(last, cur) {
  if (!last || state.snap === "off") return cur;
  const dx = cur.x - last.x, dy = cur.y - last.y;
  if (state.snap === "90") {
    return Math.abs(dx) >= Math.abs(dy)
      ? { x: cur.x, y: last.y }
      : { x: last.x, y: cur.y };
  }
  // 45°: snap the segment angle to the nearest multiple of 45°.
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  const d = Math.hypot(dx, dy);
  return { x: Math.round(last.x + d * Math.cos(ang)), y: Math.round(last.y + d * Math.sin(ang)) };
}

// Every vertex the cursor can snap onto: committed shapes + the shape in progress.
function* allVertices() {
  for (const s of state.shapes) {
    if (s.type === "point") yield s;
    else if (Array.isArray(s.pts)) for (const p of s.pts) yield p;
    else if (isElement(s)) { // element corners are snap targets too
      yield { x: s.x, y: s.y }; yield { x: s.x + s.w, y: s.y };
      yield { x: s.x + s.w, y: s.y + s.h }; yield { x: s.x, y: s.y + s.h };
    }
  }
  if (state.building) for (const p of state.building.pts) yield p;
}

// The point a click would actually land on, after all active drawing aids:
// 1) vertex snap (wins outright)  2) 90°/45° angle snap  3) equal-length.
function effectivePoint() {
  const raw = { x: state.mouse.ix, y: state.mouse.iy };
  if (state.snapPoints && state.ready) {
    const tol = 10 / state.view.scale; // ~10 screen px in image units
    let best = null, bd = tol;
    for (const v of allVertices()) {
      const d = Math.hypot(v.x - raw.x, v.y - raw.y);
      if (d <= bd) { bd = d; best = v; }
    }
    if (best) { state.snapHit = { x: best.x, y: best.y }; return { x: best.x, y: best.y }; }
  }
  state.snapHit = null;
  const b = state.building;
  const last = b && b.pts.length ? b.pts[b.pts.length - 1] : null;
  let pt = applySnap(last, raw);
  if (state.eqLen && last && b.pts.length >= 2) {
    const L = dist(b.pts[0], b.pts[1]); // the first segment sets the standard
    const dx = pt.x - last.x, dy = pt.y - last.y;
    const d = Math.hypot(dx, dy);
    if (d > 0 && L > 0) {
      pt = { x: Math.round(last.x + (dx / d) * L), y: Math.round(last.y + (dy / d) * L) };
    }
  }
  return pt;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function centroid(pts) {
  const c = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: c.x / pts.length, y: c.y / pts.length };
}

// ----- View / canvas sizing --------------------------------------------
function resizeCanvas() {
  const w = stage.clientWidth, h = stage.clientHeight;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  render();
}

function fitToView() {
  if (!state.ready) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  const scale = Math.min(w / state.W, h / state.H);
  state.view.scale = scale;
  state.view.ox = (w - state.W * scale) / 2;
  state.view.oy = (h - state.H * scale) / 2;
}

function zoomAt(sx, sy, factor) {
  const before = screenToImage(sx, sy);
  state.view.scale = Math.max(0.05, Math.min(40, state.view.scale * factor));
  // keep the image point under the cursor fixed
  state.view.ox = sx - before.x * state.view.scale;
  state.view.oy = sy - before.y * state.view.scale;
  render();
}

// ----- Rendering --------------------------------------------------------
// Draw the whole scene into `ctx` using transform `tf`.
// opts.cursor -> draw live crosshair + building preview (screen only).
function drawScene(g, tf, W, H, opts = {}) {
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);

  // Canvas mode has no document background — the windows ARE the design;
  // the workspace is just the table of stacked windows.
  if (state.ready && state.background) {
    g.imageSmoothingEnabled = tf.scale < 1;
    g.drawImage(state.background, tf.ox, tf.oy, state.W * tf.scale, state.H * tf.scale);
  } else if (state.ready && state.docMode !== "canvas") {
    g.fillStyle = state.bgColor; // blank (non-design) canvas
    g.fillRect(tf.ox, tf.oy, state.W * tf.scale, state.H * tf.scale);
  }

  if (state.grid.on && state.ready && state.docMode !== "canvas") drawGrid(g, tf, W, H);

  for (const i of zOrder(false)) { // back-to-front
    const s = state.shapes[i];
    if (isElement(s) && !responsiveVisible(s)) continue;
    const showText = state.showNumbers;
    if (s.type === "point") drawPoint(g, tf, s, showText);
    else if (s.type === "area") drawArea(g, tf, s, false, showText);
    else if (isElement(s)) {
      g.save();
      clipOverflowAncestors(g, tf, s);
      const a = s.opacity != null ? Math.max(0, Math.min(100, s.opacity)) / 100 : 1;
      if (a < 1) { g.save(); g.globalAlpha = a; drawElement(g, tf, s, showText); g.restore(); }
      else drawElement(g, tf, s, showText);
      g.restore();
    }
    if (opts.cursor && state.selection.includes(i)) drawSelection(g, tf, s);
  }

  // A composite's outer border belongs to its frame, above all descendants.
  // Its fill is painted at normal z by drawWidget; this pass closes the frame.
  for (const i of zOrder(false)) {
    const s = state.shapes[i];
    if (isComposite(s)) drawCompositeBorder(g, tf, s);
  }
  for (const c of state.shapes.filter(s => isContainer(s) && responsiveVisible(s) && s.overflow === "scroll"))
    drawAutoScrollbars(g, tf, c);

  // Marquee rectangle while rubber-band selecting.
  if (opts.cursor && state.drag && state.drag.kind === "marquee") {
    const a = toScreen(tf, Math.min(state.drag.x0, state.drag.x1), Math.min(state.drag.y0, state.drag.y1));
    const b = toScreen(tf, Math.max(state.drag.x0, state.drag.x1), Math.max(state.drag.y0, state.drag.y1));
    g.save();
    g.fillStyle = "rgba(74,158,255,0.12)";
    g.strokeStyle = "#4a9eff";
    g.setLineDash([4, 3]);
    g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.restore();
  }

  if (opts.cursor && state.moveSnap) {
    g.save();
    g.strokeStyle = "#ff3baf";
    g.lineWidth = 1;
    g.setLineDash([5, 4]);
    if (state.moveSnap.x != null) {
      const x = tf.ox + state.moveSnap.x * tf.scale;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    if (state.moveSnap.y != null) {
      const y = tf.oy + state.moveSnap.y * tf.scale;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    g.restore();
  }

  if (opts.cursor && state.dropHint) drawDropHint(g, tf, state.dropHint);

  if (state.building) drawArea(g, tf, buildingPreview(opts.cursor), true, true);

  // Live preview of the element being dragged out.
  if (opts.cursor && state.drag && state.drag.kind === "create") {
    drawElement(g, tf, draftElement(), false);
  }

  if (opts.cursor && state.mouse.over && state.mode !== "select") {
    drawCrosshair(g);
    if (state.snapHit) { // yellow ring marks the vertex we'd snap onto
      const p = toScreen(tf, state.snapHit.x, state.snapHit.y);
      g.strokeStyle = "#ffd60a";
      g.lineWidth = 2;
      g.beginPath(); g.arc(p.x, p.y, 8, 0, Math.PI * 2); g.stroke();
    }
  }

  g.restore();
}

function containerViewport(c) {
  const P = side4(c.padding, 12);
  const head = containerHeadOffset(c);
  return {
    x: c.x + P.l, y: c.y + P.t + head,
    w: Math.max(0, c.w - P.l - P.r), h: Math.max(0, c.h - P.t - P.b - head),
  };
}

function drawAutoScrollbars(g, tf, c) {
  if (!(c.scrollMaxX > 0 || c.scrollMaxY > 0)) return;
  const v = containerViewport(c), p = toScreen(tf, v.x, v.y);
  const w = v.w * tf.scale, h = v.h * tf.scale, track = Math.max(4, 6 * tf.scale);
  g.save();
  g.fillStyle = "rgba(70,78,90,0.22)";
  g.strokeStyle = "rgba(130,142,160,0.7)";
  if (c.scrollMaxY > 0) {
    const total = v.h + c.scrollMaxY, thumbH = Math.max(18 * tf.scale, h * v.h / total);
    const y = p.y + (h - thumbH) * ((c.scrollY || 0) / c.scrollMaxY);
    g.fillRect(p.x + w - track, p.y, track, h);
    g.strokeRect(p.x + w - track + 0.5, y + 0.5, track - 1, thumbH - 1);
  }
  if (c.scrollMaxX > 0) {
    const total = v.w + c.scrollMaxX, thumbW = Math.max(18 * tf.scale, w * v.w / total);
    const x = p.x + (w - thumbW) * ((c.scrollX || 0) / c.scrollMaxX);
    g.fillRect(p.x, p.y + h - track, w, track);
    g.strokeRect(x + 0.5, p.y + h - track + 0.5, thumbW - 1, track - 1);
  }
  g.restore();
}

// Flat z-order rendering still honors nested overflow by clipping each element
// to every clip/scroll ancestor's content viewport.
function clipOverflowAncestors(g, tf, s) {
  const ancestors = [];
  let p = s.parent ? byId(s.parent) : null;
  while (p) { ancestors.push(p); p = p.parent ? byId(p.parent) : null; }
  for (const c of ancestors.reverse()) {
    if (isComposite(c)) {
      compositePath(g, tf, c);
      g.clip();
      continue;
    }
    if (!isContainer(c) || !["clip", "scroll"].includes(c.overflow)) continue;
    const v = containerViewport(c), a = toScreen(tf, v.x, v.y);
    g.beginPath(); g.rect(a.x, a.y, v.w * tf.scale, v.h * tf.scale); g.clip();
  }
}

function textLines(g, text, maxWidth, mode = "wrap") {
  const raw = String(text ?? "");
  if (mode === "clip") return raw.split("\n").slice(0, 1);
  if (mode === "ellipsis") {
    if (g.measureText(raw).width <= maxWidth) return [raw];
    let out = raw;
    while (out && g.measureText(out + "…").width > maxWidth) out = out.slice(0, -1);
    return [out + "…"];
  }
  const lines = [];
  for (const para of raw.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && g.measureText(next).width > maxWidth) { lines.push(line); line = word; }
      else line = next;
    }
    lines.push(line);
  }
  return lines;
}

function drawTextBox(g, tf, s, text, bounds, defaults = {}) {
  const pad = (defaults.pad ?? 8) * tf.scale;
  const fs = Math.max(7, (s.fontSize || 14) * tf.scale);
  const ah = s.alignH || defaults.h || "center", av = s.alignV || defaults.v || "middle";
  const mode = s.textOverflow || "wrap";
  const innerW = Math.max(1, bounds.w - pad * 2), innerH = Math.max(1, bounds.h - pad * 2);
  g.save();
  g.beginPath(); g.rect(bounds.x, bounds.y, bounds.w, bounds.h); g.clip();
  g.fillStyle = defaults.color || s.textColor || "#111827";
  g.font = `${fontStyleCss(s)}${fs}px ${s.fontFamily || "system-ui, sans-serif"}`;
  g.textAlign = ah;
  g.textBaseline = "top";
  let lines = textLines(g, text, innerW, mode);
  const lineH = fs * 1.25, maxLines = Math.max(1, Math.floor(innerH / lineH));
  if (mode === "wrap" && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last && g.measureText(last + "…").width > innerW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + "…";
  }
  const totalH = lines.length * lineH;
  const x = ah === "left" ? bounds.x + pad : ah === "right" ? bounds.x + bounds.w - pad : bounds.x + bounds.w / 2;
  let y = av === "top" ? bounds.y + pad : av === "bottom" ? bounds.y + bounds.h - pad - totalH : bounds.y + (bounds.h - totalH) / 2;
  for (const line of lines) { g.fillText(line, x, y); y += lineH; }
  g.restore();
}

function drawGrid(g, tf, W, H) {
  const sp = state.grid.spacing;
  const screenStep = sp * tf.scale;
  if (screenStep < 3) return; // too dense to be useful
  // Only draw across the visible portion of the image.
  const x0 = Math.max(0, Math.floor((-tf.ox) / tf.scale / sp) * sp);
  const y0 = Math.max(0, Math.floor((-tf.oy) / tf.scale / sp) * sp);
  const x1 = Math.min(state.W, ((W - tf.ox) / tf.scale));
  const y1 = Math.min(state.H, ((H - tf.oy) / tf.scale));

  // Label every Nth line so numbers never crowd.
  const labelEvery = Math.max(1, Math.ceil(48 / screenStep));

  g.lineWidth = 1;
  g.font = "11px ui-monospace, monospace";
  g.textBaseline = "top";

  for (let x = x0, i = 0; x <= x1; x += sp, i++) {
    const p = toScreen(tf, x, 0);
    const major = x % (sp * 5) === 0;
    g.strokeStyle = major ? "rgba(120,180,255,0.45)" : "rgba(120,180,255,0.18)";
    g.beginPath();
    g.moveTo(p.x + 0.5, Math.max(0, tf.oy));
    g.lineTo(p.x + 0.5, Math.min(H, tf.oy + state.H * tf.scale));
    g.stroke();
    if (i % labelEvery === 0) {
      g.fillStyle = "rgba(160,200,255,0.9)";
      g.fillText(String(x), p.x + 2, Math.max(2, tf.oy + 2));
    }
  }
  for (let y = y0, i = 0; y <= y1; y += sp, i++) {
    const p = toScreen(tf, 0, y);
    const major = y % (sp * 5) === 0;
    g.strokeStyle = major ? "rgba(120,180,255,0.45)" : "rgba(120,180,255,0.18)";
    g.beginPath();
    g.moveTo(Math.max(0, tf.ox), p.y + 0.5);
    g.lineTo(Math.min(W, tf.ox + state.W * tf.scale), p.y + 0.5);
    g.stroke();
    if (i % labelEvery === 0) {
      g.fillStyle = "rgba(160,200,255,0.9)";
      g.fillText(String(y), Math.max(2, tf.ox + 2), p.y + 2);
    }
  }
}

function drawPoint(g, tf, s, showText = true) {
  const p = toScreen(tf, s.x, s.y);
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineWidth = 1.5;
  const r = 5;
  g.beginPath(); g.moveTo(p.x - r, p.y); g.lineTo(p.x + r, p.y);
  g.moveTo(p.x, p.y - r); g.lineTo(p.x, p.y + r); g.stroke();
  g.beginPath(); g.arc(p.x, p.y, 3, 0, Math.PI * 2); g.fill();
  if (showText) {
    const text = `${s.label ? s.label + " " : ""}(${s.x}, ${s.y})`;
    labelText(g, p.x + 8, p.y - 8, text, s.color);
  }
}

function drawArea(g, tf, s, building, showText = true) {
  const pts = s.pts;
  if (pts.length === 0) return;
  const scr = pts.map(p => toScreen(tf, p.x, p.y));

  // Fill for closed polygons.
  if (s.closed && scr.length >= 3) {
    g.beginPath();
    scr.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fillStyle = hexToRgba(s.color, 0.12);
    g.fill();
  }

  // Segments + length labels.
  g.strokeStyle = s.color;
  g.lineWidth = 2;
  g.beginPath();
  scr.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  if (s.closed) g.closePath();
  g.stroke();

  const segCount = s.closed ? pts.length : pts.length - 1;
  if (showText) {
    for (let i = 0; i < segCount; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const sa = scr[i], sb = scr[(i + 1) % pts.length];
      const len = dist(a, b);
      const mid = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 };
      labelText(g, mid.x, mid.y, `${len.toFixed(1)} px`, s.color, true);
    }
  }

  // Vertices (dots always; coordinate text only when numbers are shown).
  scr.forEach((p, i) => {
    g.fillStyle = building && i === scr.length - 1 ? "#ffffff" : s.color;
    g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill();
    if (showText) labelText(g, p.x + 7, p.y + 6, `(${pts[i].x}, ${pts[i].y})`, s.color);
  });

  // Area name + size at the centroid for closed shapes.
  if (s.closed && pts.length >= 3) {
    const c = toScreen(tf, ...Object.values(centroid(pts)));
    const area = polygonArea(pts);
    const title = [s.name, s.label].filter(Boolean).join(" · ");
    // Show the name even when numbers are hidden; only drop the px² figure.
    if (showText) {
      labelText(g, c.x, c.y, `${title ? title + "  " : ""}${Math.round(area).toLocaleString()} px²`, s.color, true);
    } else if (title) {
      labelText(g, c.x, c.y, title, s.color, true);
    }
  }
}

// Draw a design element (rectangle / ellipse / icon) with fill, stroke, text.
function drawElement(g, tf, s, showText = true) {
  const p = toScreen(tf, s.x, s.y);
  const w = s.w * tf.scale, h = s.h * tf.scale;

  if (s.type === "widget") { drawWidget(g, tf, s, p, w, h, showText); return; }

  if (s.type === "icon") {
    const img = getIconImage(s.src);
    if (img.complete && img.naturalWidth && !img._failed) {
      try { g.drawImage(img, p.x, p.y, w, h); } catch (e) { /* tainted/unsupported */ }
    } else {
      g.save(); // placeholder while loading (or on error)
      g.strokeStyle = img._failed ? "#ff5b52" : "#8a93a6";
      g.setLineDash([4, 3]); g.lineWidth = 1;
      g.strokeRect(p.x, p.y, w, h);
      g.restore();
    }
    if (showText && s.name) {
      labelText(g, p.x, p.y - 18, `${s.name}${s.fixed ? " 📌" : ""}`, "#8a93a6");
    }
    return;
  }

  g.save();
  g.beginPath();
  if (s.type === "ellipse") {
    g.ellipse(p.x + w / 2, p.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  } else {
    roundRect(g, p.x, p.y, w, h, Math.min((s.radius || 0) * tf.scale, Math.abs(w / 2), Math.abs(h / 2)));
  }
  if (s.filled !== false && s.fill && s.fill !== "none") { g.fillStyle = s.fill; g.fill(); }
  if (s.strokeWidth > 0) { g.strokeStyle = strokeColor(s, s.stroke); g.lineWidth = s.strokeWidth * tf.scale; g.stroke(); }
  if (s.text) {
    drawTextBox(g, tf, s, s.text, { x: p.x, y: p.y, w, h }, { h: "center", v: "middle", pad: 6, color: s.textColor || "#ffffff" });
  }
  g.restore();
  if (showText && s.name) {
    labelText(g, p.x, p.y - 18, `${s.name}${s.fixed ? " 📌" : ""}  ${Math.round(s.w)}×${Math.round(s.h)}`, s.stroke || "#4a9eff");
  }
}

// Render a UI widget into its box.
function drawWidget(g, tf, s, p, w, h, showText) {
  g.save();
  const cx = p.x + w / 2, cy = p.y + h / 2;
  const fs = Math.max(7, (s.fontSize || 14) * tf.scale);
  // Text placed anywhere in a supplied box per Align H/V. Specialized controls
  // can reserve space for indicators/icons while sharing the same alignment.
  // Show text is a per-widget toggle: off suppresses the label AND the
  // widget's placeholder fallback (e.g. "Button") without deleting the text.
  const textOff = s.showText === false;
  const alignedText = (str, color, defAlign, bounds = null, defAlignV = "middle") => {
    if (textOff) return;
    const b = bounds || { x: p.x, y: p.y, w, h };
    drawTextBox(g, tf, s, str, b, { h: defAlign || "center", v: defAlignV, color });
  };
  const boxText = (str, color, defAlign) => alignedText(str, color, defAlign);
  // Draw an optional SVG asset together with (or instead of) widget text.
  // The widget's normal fill/stroke remains the button/control background.
  const iconText = (str, color, defAlign = "center") => {
    if (!s.icon) { boxText(str, color, defAlign); return; }
    const img = getIconImage(s.icon);
    const rawSize = Math.max(8, Number(s.iconSize) || 18) * tf.scale;
    const size = Math.min(rawSize, Math.max(1, w - 8 * tf.scale), Math.max(1, h - 8 * tf.scale));
    const gap = Math.max(0, Number(s.iconGap) || 6) * tf.scale;
    const pos = s.iconPosition || (s.widget === "toolbutton" ? "only" : "left");
    const hasText = pos !== "only" && !!str && !textOff;
    let ix = cx - size / 2, iy = cy - size / 2;
    let tx = cx, ty = cy, align = "center";
    if (hasText && pos === "left") {
      ix = p.x + 8 * tf.scale; tx = ix + size + gap; align = "left";
    } else if (hasText && pos === "right") {
      ix = p.x + w - 8 * tf.scale - size; tx = ix - gap; align = "right";
    } else if (hasText && pos === "top") {
      iy = p.y + 4 * tf.scale; ty = iy + size + gap + fs / 2;
    } else if (hasText && pos === "bottom") {
      iy = p.y + h - 4 * tf.scale - size; ty = iy - gap - fs / 2;
    }
    if (img.complete && img.naturalWidth && !img._failed) {
      try { g.drawImage(img, ix, iy, size, size); } catch (e) { /* unsupported SVG */ }
    }
    if (hasText) {
      g.fillStyle = color || s.textColor || "#111827";
      g.font = `${fontStyleCss(s)}${fs}px ${s.fontFamily || "system-ui, sans-serif"}`; g.textAlign = align; g.textBaseline = "middle";
      g.fillText(str, tx, ty);
    }
  };
  let shadowDrawn = false; // one shadow per widget, on its first filled box
  const box = (x, y, bw, bh, r, fill, stroke) => {
    g.beginPath(); roundRect(g, x, y, bw, bh, Math.min(r * tf.scale, bw / 2, bh / 2));
    if (fill && fill !== "none") {
      if (s.shadow && !shadowDrawn) {
        shadowDrawn = true;
        g.save();
        g.shadowColor = "rgba(0,0,0,0.28)";
        g.shadowBlur = (s.widget === "window" ? 26 : 10) * tf.scale;
        g.shadowOffsetY = (s.widget === "window" ? 8 : 3) * tf.scale;
        g.fillStyle = fill; g.fill();
        g.restore();
      } else { g.fillStyle = fill; g.fill(); }
    }
    if ((s.strokeWidth || 0) > 0 && stroke) { g.strokeStyle = strokeColor(s, stroke); g.lineWidth = (s.strokeWidth || 1) * tf.scale; g.stroke(); }
  };

  switch (s.widget) {
    case "composite": {
      const f = s.frame || {};
      compositePath(g, tf, s);
      if (f.filled !== false && f.fill && f.fill !== "none") { g.fillStyle = f.fill; g.fill(); }
      break;
    }
    case "button":
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      iconText(s.text || (s.icon ? "" : "Button"), s.textColor || "#111827", "center");
      break;
    case "textbox":
      box(p.x, p.y, w, h, s.radius || 0, s.fill || "#ffffff", s.stroke);
      iconText(s.text || "", s.textColor || "#6b7280", "left");
      break;
    case "label":
      boxText(s.text || "Label", s.textColor || "#111827", "left");
      break;
    case "checkbox": {
      const bs = Math.min(h, 18 * tf.scale);
      box(p.x, cy - bs / 2, bs, bs, s.radius || 3, s.checked ? s.fill : "#ffffff", s.stroke);
      if (s.checked) { // check mark
        g.strokeStyle = "#111827"; g.lineWidth = Math.max(1.5, 2 * tf.scale); g.lineCap = "round";
        g.beginPath();
        g.moveTo(p.x + bs * 0.24, cy);
        g.lineTo(p.x + bs * 0.44, cy + bs * 0.22);
        g.lineTo(p.x + bs * 0.78, cy - bs * 0.22);
        g.stroke();
      }
      alignedText(s.text || "Checkbox", s.textColor || "#111827", "left",
        { x: p.x + bs, y: p.y, w: Math.max(1, w - bs), h });
      break;
    }
    case "toggle": {
      const track = s.on ? s.fill : "#c9ced6";
      box(p.x, p.y, w, h, h / 2 / tf.scale, track, s.stroke);
      const kr = h / 2 - 3 * tf.scale;
      const kx = s.on ? p.x + w - kr - 3 * tf.scale : p.x + kr + 3 * tf.scale;
      g.beginPath(); g.arc(kx, cy, Math.max(2, kr), 0, Math.PI * 2);
      g.fillStyle = s.thumbFill || "#e5e7eb"; g.fill();
      break;
    }
    case "slider": {
      const v = Math.max(0, Math.min(100, s.value != null ? s.value : 50)) / 100;
      g.strokeStyle = "#c9ced6"; g.lineWidth = Math.max(2, 3 * tf.scale); g.lineCap = "round";
      g.beginPath(); g.moveTo(p.x, cy); g.lineTo(p.x + w, cy); g.stroke();
      g.strokeStyle = s.fill || "#4a9eff";
      g.beginPath(); g.moveTo(p.x, cy); g.lineTo(p.x + w * v, cy); g.stroke();
      g.beginPath(); g.arc(p.x + w * v, cy, Math.max(4, 7 * tf.scale), 0, Math.PI * 2);
      g.fillStyle = s.fill || "#4a9eff"; g.fill();
      g.strokeStyle = "#ffffff"; g.lineWidth = Math.max(1, 1.5 * tf.scale); g.stroke();
      break;
    }
    case "window":
      // Windows are plain framed containers; all chrome (Title bar, controls,
      // hamburger) is real child widgets from the toolkit presets.
      box(p.x, p.y, w, h, s.radius || 0, s.fill || "#ffffff", s.stroke);
      break;
    case "section": {
      const B = borderSides4(s);
      const partial = !(B.t && B.r && B.b && B.l);
      g.save();
      if ((s.strokeStyle || "solid") === "dashed") g.setLineDash([5, 4]);
      if (partial) {
        box(p.x, p.y, w, h, s.radius || 0, s.fill, null);
        if ((s.strokeWidth || 0) > 0 && s.stroke && s.stroke !== "none") {
          g.strokeStyle = strokeColor(s, s.stroke); g.lineWidth = (s.strokeWidth || 1) * tf.scale;
          const seg = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
          if (B.t) seg(p.x, p.y, p.x + w, p.y);
          if (B.b) seg(p.x, p.y + h, p.x + w, p.y + h);
          if (B.l) seg(p.x, p.y, p.x, p.y + h);
          if (B.r) seg(p.x + w, p.y, p.x + w, p.y + h);
        }
      } else {
        box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      }
      g.restore();
      if (sectionCaptionVisible(s)) {
        if ((s.captionMode || "block") === "border") {
          // Legend-style caption sitting on the border line (fieldset/GtkFrame).
          const fsL = Math.max(8, (s.fontSize || 14) * tf.scale * 0.86);
          g.font = `${fontStyleCss(s)}${fsL}px ${s.fontFamily || "system-ui, sans-serif"}`;
          const tw = g.measureText(s.text).width + 12 * tf.scale;
          const inset = 10 * tf.scale;
          const ax = s.captionAlign || "left";
          const lx = ax === "center" ? p.x + (w - tw) / 2 : ax === "right" ? p.x + w - inset - tw : p.x + inset;
          const ly = (s.captionSide || "top") === "bottom" ? p.y + h : p.y;
          g.fillStyle = effectiveBg(s);
          g.fillRect(lx, ly - fsL * 0.8, tw, fsL * 1.6);
          g.fillStyle = s.textColor || "#6b7280";
          g.textAlign = "center"; g.textBaseline = "middle";
          g.fillText(s.text, lx + tw / 2, ly);
        } else {
          alignedText(s.text, s.textColor || "#6b7280", "left", null, "top");
        }
      }
      break;
    }
    case "radio": {
      const rr = Math.min(h, 18 * tf.scale) / 2;
      g.beginPath(); g.arc(p.x + rr, cy, rr, 0, Math.PI * 2);
      g.fillStyle = "#ffffff"; g.fill();
      if ((s.strokeWidth || 0) > 0) { g.strokeStyle = strokeColor(s, s.stroke); g.lineWidth = (s.strokeWidth || 1) * tf.scale; g.stroke(); }
      if (s.checked) { g.beginPath(); g.arc(p.x + rr, cy, rr * 0.5, 0, Math.PI * 2); g.fillStyle = s.fill || "#4a9eff"; g.fill(); }
      alignedText(s.text || "Option", s.textColor || "#111827", "left",
        { x: p.x + rr * 2, y: p.y, w: Math.max(1, w - rr * 2), h });
      break;
    }
    case "dropdown":
      box(p.x, p.y, w, h, s.radius || 0, s.fill || "#ffffff", s.stroke);
      alignedText(s.text || "Select…", s.textColor || "#6b7280", "left",
        { x: p.x, y: p.y, w: Math.max(1, w - 26 * tf.scale), h });
      g.fillStyle = "#6b7280"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("▾", p.x + w - 12 * tf.scale, cy);
      break;
    case "progress": {
      const v = Math.max(0, Math.min(100, s.value != null ? s.value : 50)) / 100;
      g.beginPath(); roundRect(g, p.x, p.y, w, h, h / 2); g.fillStyle = "#c9ced6"; g.fill();
      g.save(); g.beginPath(); roundRect(g, p.x, p.y, w, h, h / 2); g.clip();
      g.fillStyle = s.fill || "#4a9eff"; g.fillRect(p.x, p.y, w * v, h); g.restore();
      break;
    }
    case "image": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill || "#eef1f5", s.stroke);
      // A chosen asset (built-in SVG or user PNG/SVG) renders inside the
      // frame, letterboxed to preserve its aspect ratio.
      if (s.src) {
        const img = getIconImage(s.src);
        if (img.complete && img.naturalWidth && !img._failed) {
          const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
          const iw = img.naturalWidth * scale, ih = img.naturalHeight * scale;
          g.save();
          g.beginPath(); roundRect(g, p.x, p.y, w, h, Math.min((s.radius || 0) * tf.scale, w / 2, h / 2)); g.clip();
          try { g.drawImage(img, p.x + (w - iw) / 2, p.y + (h - ih) / 2, iw, ih); } catch (e) { /* unsupported */ }
          g.restore();
          break;
        }
      }
      g.strokeStyle = s.textColor || "#9aa1ac"; g.fillStyle = s.textColor || "#9aa1ac";
      g.lineWidth = Math.max(1, 1.5 * tf.scale);
      g.beginPath(); g.arc(p.x + w * 0.32, p.y + h * 0.34, Math.max(3, Math.min(w, h) * 0.08), 0, Math.PI * 2); g.fill(); // sun
      g.beginPath(); // mountains
      g.moveTo(p.x + w * 0.12, p.y + h * 0.8);
      g.lineTo(p.x + w * 0.42, p.y + h * 0.45);
      g.lineTo(p.x + w * 0.62, p.y + h * 0.65);
      g.lineTo(p.x + w * 0.8, p.y + h * 0.4);
      g.lineTo(p.x + w * 0.9, p.y + h * 0.8);
      g.stroke();
      break;
    }
    case "list": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill || "#ffffff", s.stroke);
      const n = Math.max(0, Math.min(50, s.count != null ? s.count : 4));
      const rowH = n > 0 ? h / n : h;
      g.save();
      g.beginPath(); roundRect(g, p.x, p.y, w, h, Math.min((s.radius || 0) * tf.scale, w / 2, h / 2)); g.clip();
      for (let i = 0; i < n; i++) {
        const ry = p.y + i * rowH;
        if (i > 0) { g.strokeStyle = "rgba(0,0,0,0.10)"; g.lineWidth = 1; g.beginPath(); g.moveTo(p.x, ry); g.lineTo(p.x + w, ry); g.stroke(); }
        alignedText(`${s.text || "Item"} ${i + 1}`, s.textColor || "#111827", "left",
          { x: p.x, y: ry, w, h: rowH });
      }
      g.restore();
      break;
    }
    case "scrollbar": {
      const vertical = h > w;
      const v = Math.max(0, Math.min(100, s.value != null ? s.value : 0)) / 100;
      const trackFill = s.fill || "#dfe3e8";
      box(p.x, p.y, w, h, Math.min(w, h) / 2 / tf.scale, trackFill, s.stroke);
      const length = vertical ? h : w;
      const thickness = vertical ? w : h;
      const thumbLength = Math.max(thickness, length * 0.3);
      const travel = Math.max(0, length - thumbLength);
      const tx = vertical ? p.x : p.x + travel * v;
      const ty = vertical ? p.y + travel * v : p.y;
      const tw = vertical ? w : thumbLength;
      const th = vertical ? thumbLength : h;
      g.beginPath(); roundRect(g, tx, ty, tw, th, Math.min(tw, th) / 2);
      g.fillStyle = s.thumbFill || s.textColor || "#7b8490"; g.fill();
      break;
    }
    case "clock": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      const time = s.text || "10:24";
      boxText(time, s.textColor || "#111827", "center");
      break;
    }
    case "calendar": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill || "#ffffff", s.stroke);
      const headerH = Math.min(34 * tf.scale, h * 0.25);
      g.save();
      g.beginPath(); roundRect(g, p.x, p.y, w, h, Math.min((s.radius || 0) * tf.scale, w / 2, h / 2)); g.clip();
      g.fillStyle = s.headerFill || "#4a9eff"; g.fillRect(p.x, p.y, w, headerH);
      alignedText(s.text || "July 2026", s.headerTextColor || "#ffffff", "center",
        { x: p.x, y: p.y, w, h: headerH });
      g.textAlign = "center"; g.textBaseline = "middle";
      const labels = ["M", "T", "W", "T", "F", "S", "S"];
      const cellW = w / 7, cellH = (h - headerH) / 6;
      g.fillStyle = s.textColor || "#111827"; g.font = `${fontStyleCss(s)}${Math.max(6, fs * 0.72)}px ${s.fontFamily || "system-ui, sans-serif"}`;
      labels.forEach((label, i) => g.fillText(label, p.x + cellW * (i + 0.5), p.y + headerH + cellH * 0.5));
      for (let day = 1; day <= 31; day++) {
        const pos = day + 1; // example month starts on Wednesday
        const col = pos % 7, row = Math.floor(pos / 7) + 1;
        g.fillText(String(day), p.x + cellW * (col + 0.5), p.y + headerH + cellH * (row + 0.5));
      }
      g.restore();
      break;
    }
    case "menubar": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      if (childrenOf(s).length) break;
      const items = (s.text || "File Edit View Help").split(/\s*[|,]\s*|\s+/).filter(Boolean);
      g.fillStyle = s.textColor || "#111827"; g.font = `${fontStyleCss(s)}${fs}px ${s.fontFamily || "system-ui, sans-serif"}`;
      g.textAlign = "left"; g.textBaseline = "middle";
      let mx = p.x + 10 * tf.scale;
      for (const item of items) { g.fillText(item, mx, cy); mx += (g.measureText(item).width + 18 * tf.scale); }
      break;
    }
    case "toolbar": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      if (childrenOf(s).length) break;
      const count = Math.max(1, Math.min(12, s.count != null ? s.count : 5));
      const size = Math.min(h * 0.62, 22 * tf.scale), gap = 8 * tf.scale;
      let bx = p.x + 10 * tf.scale;
      for (let i = 0; i < count; i++) {
        g.beginPath(); roundRect(g, bx, cy - size / 2, size, size, Math.max(2, 3 * tf.scale));
        g.fillStyle = s.buttonFill || "rgba(127,127,127,0.18)"; g.fill();
        g.strokeStyle = s.textColor || "#59636e"; g.lineWidth = Math.max(1, tf.scale);
        g.beginPath(); g.moveTo(bx + size * 0.28, cy); g.lineTo(bx + size * 0.72, cy); g.stroke();
        if (i % 2 === 0) { g.beginPath(); g.moveTo(bx + size / 2, cy - size * 0.22); g.lineTo(bx + size / 2, cy + size * 0.22); g.stroke(); }
        bx += size + gap;
      }
      break;
    }
    case "menuitem":
      iconText(s.text || (s.icon ? "" : "Menu"), s.textColor || "#111827", "center");
      break;
    case "toolbutton": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      const glyph = s.text || "+";
      iconText(s.icon && s.iconPosition === "only" ? "" : glyph, s.textColor || "#59636e", "center");
      break;
    }
    case "separator": {
      g.strokeStyle = strokeColor(s, s.stroke || "#9aa1ac");
      g.lineWidth = Math.max(1, (s.strokeWidth || 1) * tf.scale);
      const lines = s.lines === 2 ? 2 : 1;
      const gapPx = 3 * tf.scale;
      // Two lines straddle the centre; one sits on it.
      const offs = lines === 2 ? [-gapPx / 2, gapPx / 2] : [0];
      g.beginPath();
      if (h > w) for (const o of offs) { g.moveTo(cx + o, p.y); g.lineTo(cx + o, p.y + h); }
      else for (const o of offs) { g.moveTo(p.x, cy + o); g.lineTo(p.x + w, cy + o); }
      g.stroke();
      break;
    }
    case "titlebar":
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      break;
    case "statusbar":
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      boxText(s.text || "Ready", s.textColor || "#59636e", "left");
      break;
    case "breadcrumb": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      const parts = String(s.text || "Home / Documents / Project").split(/\s*\/\s*/).filter(Boolean);
      g.font = `${fontStyleCss(s)}${fs}px ${s.fontFamily || "system-ui, sans-serif"}`; g.textBaseline = "middle"; g.textAlign = "left";
      let bx = p.x + 10 * tf.scale;
      parts.forEach((part, i) => {
        g.fillStyle = i === parts.length - 1 ? (s.textColor || "#111827") : "#6b7280";
        g.fillText(part, bx, cy); bx += g.measureText(part).width;
        if (i < parts.length - 1) {
          g.fillStyle = "#9aa1ac"; g.fillText("›", bx + 8 * tf.scale, cy); bx += 24 * tf.scale;
        }
      });
      break;
    }
    case "searchfield":
      box(p.x, p.y, w, h, s.radius || 0, s.fill || "#ffffff", s.stroke);
      g.strokeStyle = s.textColor || "#6b7280"; g.lineWidth = Math.max(1.2, 1.5 * tf.scale);
      g.beginPath(); g.arc(p.x + 14 * tf.scale, cy - tf.scale, 5 * tf.scale, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(p.x + 18 * tf.scale, cy + 3 * tf.scale); g.lineTo(p.x + 22 * tf.scale, cy + 7 * tf.scale); g.stroke();
      alignedText(s.text || "Search…", s.textColor || "#6b7280", "left",
        { x: p.x + 24 * tf.scale, y: p.y, w: Math.max(1, w - 24 * tf.scale), h });
      break;
    case "splitpane": {
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      // Children provide the real pane contents; the divider is always visible.
      const vertical = (s.layout || s.orientation) === "vertical";
      const ratio = Math.max(10, Math.min(90, Number(s.value) || 50)) / 100;
      g.strokeStyle = strokeColor(s, s.stroke || "#9aa1ac"); g.lineWidth = Math.max(1, tf.scale);
      g.beginPath();
      if (vertical) { const yy = p.y + h * ratio; g.moveTo(p.x, yy); g.lineTo(p.x + w, yy); }
      else { const xx = p.x + w * ratio; g.moveTo(xx, p.y); g.lineTo(xx, p.y + h); }
      g.stroke();
      break;
    }
    case "spacer": {
      // Invisible flexible gap. Only hint it when selected so it stays
      // discoverable without cluttering the mockup.
      const idx = state.shapes.indexOf(s);
      if (state.selection.includes(idx) || state.selected === idx) {
        g.save(); g.setLineDash([4, 4]);
        g.strokeStyle = "rgba(74,158,255,0.7)"; g.lineWidth = 1;
        g.strokeRect(p.x + 0.5, p.y + 0.5, w - 1, h - 1);
        g.setLineDash([]);
        g.fillStyle = "rgba(74,158,255,0.9)"; g.font = `${Math.min(fs, h * 0.7)}px system-ui, sans-serif`;
        g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("↔", cx, cy);
        g.restore();
      }
      break;
    }
    case "tabs": {
      const count = Math.max(1, Math.min(12, s.count != null ? s.count : 3));
      const active = Math.max(0, Math.min(count - 1, s.active || 0));
      const tabW = w / count;
      g.font = `${fontStyleCss(s)}${fs}px ${s.fontFamily || "system-ui, sans-serif"}`; g.textBaseline = "middle";
      for (let i = 0; i < count; i++) {
        const tx = p.x + i * tabW;
        const on = i === active;
        g.beginPath(); roundRect(g, tx, p.y, tabW, h, Math.min((s.radius || 0) * tf.scale, tabW / 2, h / 2));
        g.fillStyle = on ? (s.fill || "#ffffff") : "rgba(127,127,127,0.10)"; g.fill();
        if ((s.strokeWidth || 0) > 0) { g.strokeStyle = strokeColor(s, s.stroke || "#c9ced6"); g.lineWidth = Math.max(1, tf.scale); g.stroke(); }
        alignedText(`${s.text || "Tab"} ${i + 1}`, on ? (s.textColor || "#111827") : "#8b929c", "center",
          { x: tx, y: p.y, w: tabW, h });
        if (on) { // active underline accent
          g.strokeStyle = s.accent || "#4a9eff"; g.lineWidth = Math.max(2, 2 * tf.scale);
          g.beginPath(); g.moveTo(tx + 6 * tf.scale, p.y + h - 1); g.lineTo(tx + tabW - 6 * tf.scale, p.y + h - 1); g.stroke();
        }
      }
      break;
    }
    case "wincontrols": {
      // Close / maximize / minimize buttons. GTK draws filled circles; KDE draws
      // outlined glyph buttons. Order follows the `controls` list, packed evenly.
      const items = String(s.controls || "min,max,close").split(",").map(t => t.trim()).filter(Boolean);
      const n = Math.max(1, items.length);
      const r = Math.max(4, Math.min(h * 0.34, 11 * tf.scale));
      const slotW = w / n;
      const tc = s.textColor || "#59636e";
      g.lineWidth = Math.max(1.4, 1.8 * tf.scale); g.lineCap = "round";
      items.forEach((ctl, i) => {
        const bxc = p.x + slotW * (i + 0.5), byc = cy;
        if (s.toolkit === "kde") {
          g.strokeStyle = tc; g.fillStyle = "rgba(127,127,127,0.10)";
          g.beginPath(); g.arc(bxc, byc, r, 0, Math.PI * 2); g.fill(); g.stroke();
          g.strokeStyle = tc; g.beginPath();
          const q = r * 0.45;
          if (ctl === "close") { g.moveTo(bxc - q, byc - q); g.lineTo(bxc + q, byc + q); g.moveTo(bxc + q, byc - q); g.lineTo(bxc - q, byc + q); }
          else if (ctl === "max") { g.rect(bxc - q, byc - q, q * 2, q * 2); }
          else { g.moveTo(bxc - q, byc); g.lineTo(bxc + q, byc); }
          g.stroke();
        } else {
          g.beginPath(); g.arc(bxc, byc, r, 0, Math.PI * 2);
          g.fillStyle = "rgba(127,127,127,0.14)"; g.fill();
          g.strokeStyle = tc; g.beginPath();
          const q = r * 0.42;
          if (ctl === "close") { g.moveTo(bxc - q, byc - q); g.lineTo(bxc + q, byc + q); g.moveTo(bxc + q, byc - q); g.lineTo(bxc - q, byc + q); }
          else if (ctl === "max") { g.rect(bxc - q, byc - q, q * 2, q * 2); }
          else { g.moveTo(bxc - q, byc); g.lineTo(bxc + q, byc); }
          g.stroke();
        }
      });
      break;
    }
    case "file":
    case "storage":
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      boxText((s.widget === "file" ? "📄 " : "⛁ ") + (s.text || s.widget), s.textColor, "left");
      break;
    default:
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      boxText(s.text || s.widget, s.textColor, "center");
  }
  g.restore();
  if (showText && s.name) {
    labelText(g, p.x, p.y - 18, `${s.name}${s.fixed ? " 📌" : ""}`, s.stroke || "#4a9eff");
  }
}

// Axis-aligned bounding box of any shape, in image coordinates.
function shapeBBox(s) {
  if (s.type === "rect" || s.type === "ellipse" || s.type === "icon" || s.type === "widget") {
    const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h);
    return { x, y, w: Math.abs(s.w), h: Math.abs(s.h) };
  }
  const pts = s.type === "point" ? [{ x: s.x, y: s.y }] : s.pts;
  const bb = boundingBox(pts);
  return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// Image-space position of each resize handle for a bbox.
function handlePoints(bb) {
  const { x, y, w, h } = bb, mx = x + w / 2, my = y + h / 2;
  return {
    nw: { x, y }, n: { x: mx, y }, ne: { x: x + w, y },
    e: { x: x + w, y: my }, se: { x: x + w, y: y + h }, s: { x: mx, y: y + h },
    sw: { x, y: y + h }, w: { x, y: my },
  };
}

// Which resize handle (if any) is under the given screen point, for shape `s`.
function handleAtScreen(s, sx, sy) {
  if (!isElement(s)) return null;
  if (isWindow(s)) return null; // windows resize from the properties panel only
  const hp = handlePoints(shapeBBox(s));
  for (const key of HANDLES) {
    const scr = toScreen(state.view, hp[key].x, hp[key].y);
    if (Math.hypot(scr.x - sx, scr.y - sy) <= 7) return key;
  }
  return null;
}

// Dashed highlight (+ resize handles for elements) around the selected shape.
function drawSelection(g, tf, s) {
  const bb = shapeBBox(s);
  // Keep the dashed highlight off the element's own border: draw it a few
  // screen pixels outside the bounds so solid/per-side borders stay readable.
  const pad = isElement(s) ? 3 : 8;
  const a = toScreen(tf, bb.x, bb.y), b = toScreen(tf, bb.x + bb.w, bb.y + bb.h);
  g.save();
  g.strokeStyle = "#4a9eff";
  g.lineWidth = 1.5;
  g.setLineDash([6, 4]);
  if (isComposite(s)) { compositePath(g, tf, s); g.stroke(); }
  else g.strokeRect(a.x - pad, a.y - pad, (b.x - a.x) + pad * 2, (b.y - a.y) + pad * 2);
  g.setLineDash([]);
  if (isElement(s) && state.selection.length === 1) {
    const hp = handlePoints(bb);
    g.fillStyle = "#ffffff";
    g.strokeStyle = "#4a9eff";
    for (const key of HANDLES) {
      const scr = toScreen(tf, hp[key].x, hp[key].y);
      g.fillRect(scr.x - 4, scr.y - 4, 8, 8);
      g.strokeRect(scr.x - 4, scr.y - 4, 8, 8);
    }
  }
  g.restore();
}

function buildingPreview(withCursor) {
  const pts = state.building.pts.slice();
  if (withCursor && state.mouse.over) {
    pts.push(effectivePoint());
  }
  return {
    type: "area", pts, closed: false,
    color: document.getElementById("areaColor").value,
    name: "", label: "",
  };
}

function drawCrosshair(g) {
  const { sx, sy, ix, iy } = state.mouse;
  const x = sx * dpr, y = sy * dpr;
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, g.canvas.height);
  g.moveTo(0, y + 0.5); g.lineTo(g.canvas.width, y + 0.5);
  g.stroke();
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
}

function drawDropHint(g, tf, hint) {
  const c = hint.container, a = toScreen(tf, c.x, c.y);
  g.save();
  g.fillStyle = "rgba(74,158,255,0.10)"; g.strokeStyle = "#4a9eff";
  g.lineWidth = 2; g.setLineDash([7, 4]);
  g.fillRect(a.x, a.y, c.w * tf.scale, c.h * tf.scale);
  g.strokeRect(a.x, a.y, c.w * tf.scale, c.h * tf.scale);
  g.setLineDash([]); g.strokeStyle = "#ff3baf"; g.lineWidth = 3;
  const p1 = toScreen(tf, hint.line.x1, hint.line.y1), p2 = toScreen(tf, hint.line.x2, hint.line.y2);
  g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
  g.restore();
}

// Rounded label with a dark backdrop for legibility over any screenshot.
function labelText(g, x, y, text, color, center = false) {
  g.font = "12px ui-monospace, monospace";
  const w = g.measureText(text).width;
  const padX = 5, h = 17;
  let bx = center ? x - w / 2 - padX : x;
  let by = center ? y - h / 2 : y - h;
  g.fillStyle = "rgba(10,12,16,0.82)";
  roundRect(g, bx, by, w + padX * 2, h, 4); g.fill();
  g.fillStyle = color || "#fff";
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillText(text, bx + padX, by + h / 2);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function cornerRadii(s) {
  const f = s.frame || {};
  const all = Math.max(0, Number(f.radius != null ? f.radius : s.radius) || 0);
  return {
    tl: Math.max(0, Number(f.radiusTL != null ? f.radiusTL : all) || 0),
    tr: Math.max(0, Number(f.radiusTR != null ? f.radiusTR : all) || 0),
    br: Math.max(0, Number(f.radiusBR != null ? f.radiusBR : all) || 0),
    bl: Math.max(0, Number(f.radiusBL != null ? f.radiusBL : all) || 0),
  };
}

function roundedCornersPath(g, x, y, w, h, radii) {
  const cap = Math.max(0, Math.min(Math.abs(w), Math.abs(h)) / 2);
  const r = Object.fromEntries(Object.entries(radii).map(([k, v]) => [k, Math.min(cap, Math.max(0, v))]));
  g.beginPath();
  g.moveTo(x + r.tl, y);
  g.lineTo(x + w - r.tr, y); g.quadraticCurveTo(x + w, y, x + w, y + r.tr);
  g.lineTo(x + w, y + h - r.br); g.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
  g.lineTo(x + r.bl, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r.bl);
  g.lineTo(x, y + r.tl); g.quadraticCurveTo(x, y, x + r.tl, y);
  g.closePath();
}

function compositePath(g, tf, s) {
  const p = toScreen(tf, s.x, s.y), r = cornerRadii(s);
  roundedCornersPath(g, p.x, p.y, s.w * tf.scale, s.h * tf.scale,
    { tl: r.tl * tf.scale, tr: r.tr * tf.scale, br: r.br * tf.scale, bl: r.bl * tf.scale });
}

function drawCompositeBorder(g, tf, s) {
  const f = s.frame || {};
  const width = Math.max(0, Number(f.strokeWidth != null ? f.strokeWidth : 1) || 0);
  if (!width || !f.stroke || f.stroke === "none") return;
  g.save(); compositePath(g, tf, s);
  g.strokeStyle = strokeColor({ strokeOpacity: f.strokeOpacity }, f.stroke);
  g.lineWidth = width * tf.scale; g.stroke(); g.restore();
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Border color with the element's own border opacity applied.
// Per-side border enables: true/absent = all four; object = per-side booleans.
function borderSides4(s) {
  const v = s.borderSides;
  if (v == null || v === true) return { t: true, r: true, b: true, l: true };
  if (v === false) return { t: false, r: false, b: false, l: false };
  return { t: v.t !== false, r: v.r !== false, b: v.b !== false, l: v.l !== false };
}

// Canvas font prefix for bold/italic text styling.
const fontStyleCss = (s) => `${s.italic ? "italic " : ""}${s.bold ? "700 " : ""}`;

// Nearest visible background behind an element (for legend caption chips).
function effectiveBg(s) {
  for (let p = s; p; p = p.parent ? byId(p.parent) : null)
    if (p.fill && p.fill !== "none") return p.fill;
  return "#ffffff";
}

function strokeColor(s, c) {
  const a = s.strokeOpacity != null ? Math.max(0, Math.min(100, s.strokeOpacity)) / 100 : 1;
  return a >= 1 || !c || c[0] !== "#" ? c : hexToRgba(c, a);
}

// Normalize a margin/padding value: number → same on all sides; object → t/r/b/l.
function side4(v, def = 0) {
  if (v == null) return { t: def, r: def, b: def, l: def };
  if (typeof v === "number") return { t: v, r: v, b: v, l: v };
  return { t: v.t || 0, r: v.r || 0, b: v.b || 0, l: v.l || 0 };
}

const normalizeAlign = (v) => ({ left: "start", right: "end" }[v] ||
  (["start", "center", "end", "stretch"].includes(v) ? v : "start"));
const normalizeJustify = (v) => ["start", "center", "end", "space-between", "space-around", "space-evenly"].includes(v)
  ? v : "start";
const sectionCaptionVisible = (s) => s?.widget === "section" &&
  s.showText !== false && // Show text off overrides the caption too
  (s.showCaption != null ? !!s.showCaption : !!String(s.text || "").trim());
// Windows reserve no painted-chrome strip — their Title bar is a real child.
// Sections reserve caption space only for block captions above the content;
// border captions (legend style) sit on the border line itself.
const containerHeadOffset = (c) => {
  if (c.widget === "window") return 0;
  return sectionCaptionVisible(c) && (c.captionMode || "block") === "block" ? 22 : 0;
};

function render() {
  // The live canvas is in device pixels; scale the transform by dpr.
  const tf = {
    scale: state.view.scale * dpr,
    ox: state.view.ox * dpr,
    oy: state.view.oy * dpr,
  };
  // Refresh the snap indicator before drawing (effectivePoint sets snapHit).
  if (state.ready && state.mouse.over && state.mode !== "select") effectivePoint();
  else state.snapHit = null;
  drawScene(ctx, tf, canvas.width, canvas.height, { cursor: true });
  updateReadout();
  document.getElementById("scaleBox").textContent = Math.round(state.view.scale * 100) + "%";
}

function updateReadout() {
  if (!state.ready) { coordsEl.textContent = "no document yet"; return; }
  const m = state.mouse;
  let extra = "";
  if (state.building && state.building.pts.length) {
    const last = state.building.pts[state.building.pts.length - 1];
    const cur = applySnap(last, { x: m.ix, y: m.iy });
    extra = `  Δ ${dist(last, cur).toFixed(1)}px`;
  }
  coordsEl.textContent = m.over ? `X ${m.ix}  Y ${m.iy}${extra}` : `${state.W}×${state.H}`;
}

// ----- Actions ----------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Show a full-screen countdown for `seconds` before resolving.
async function runCountdown(seconds) {
  const el = document.getElementById("countdown");
  el.classList.add("show");
  for (let n = seconds; n > 0; n--) {
    el.textContent = n;
    await sleep(1000);
  }
  el.classList.remove("show");
  el.textContent = "";
}

// ----- Start-mode chooser ----------------------------------------------
function showStart() { document.getElementById("start").classList.remove("hidden"); }
function hideStart() { document.getElementById("start").classList.add("hidden"); }

async function capture() {
  const delay = Number(document.getElementById("timer").value) || 0;
  if (delay > 0) { await runCountdown(delay); await sleep(80); } // let the overlay clear
  hintEl.textContent = "Capturing…";
  try {
    const res = await fetch("/capture", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "capture failed");
    await loadImage(data.image);
    toast("Captured " + state.W + "×" + state.H + (data.backend ? " with " + data.backend : ""));
  } catch (err) {
    hintEl.textContent = "";
    toast("Capture failed: " + err.message, true);
  }
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      state.background = img;
      state.ready = true;
      state.docMode = "screenshot";
      state.W = img.naturalWidth;
      state.H = img.naturalHeight;
      state.shapes = [];
      clearSelection();
      state.building = null;
      closeProps();
      applyModeUI();
      fitToView();
      hintEl.textContent = "";
      hideStart();
      render();
      resolve();
    };
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = dataUrl;
  });
}

// Create a blank design canvas of the given size (no background screenshot).
function newCanvas(w, h) {
  state.background = null;
  state.ready = true;
  state.docMode = "canvas";
  state.W = Math.max(1, Math.round(w));
  state.H = Math.max(1, Math.round(h));
  state.shapes = [];
  state.aiTheme = null; // fresh design → stamp the canonical template on export
  state.editComposite = null;
  clearSelection();
  state.building = null;
  state.mode = "select";
  // Canvas mode identifies elements through the Elements tree / `tree`
  // command; name overlays start off (the Show checkbox re-enables them).
  state.showNumbers = false;
  document.getElementById("showNumbers").checked = false;
  closeProps();
  applyModeUI();
  fitToView();
  hintEl.textContent = "";
  hideStart();
  render();
}

// Groups that relocate in creation mode (home position recorded once):
// tools (mode + actions) → left sidebar "Tools" section; grid/show → bottom bar.
const RELOCATE_GROUPS = { modeGroup: "toolsHost", actionGroup: "toolsHost", gridGroup: "bottomBar", showGroup: "bottomBar" };
let groupHomes = null;
function relocateGroups(toCanvas) {
  if (!groupHomes) {
    groupHomes = Object.entries(RELOCATE_GROUPS).map(([id, target]) => {
      const el = document.getElementById(id);
      return { el, target: document.getElementById(target), parent: el.parentNode, next: el.nextSibling };
    });
  }
  // Restore in reverse so each group's original nextSibling is back in place first.
  const list = toCanvas ? groupHomes : [...groupHomes].reverse();
  for (const g of list) {
    if (toCanvas) g.target.appendChild(g.el);
    else g.parent.insertBefore(g.el, g.next);
  }
}

// Show only the tools relevant to the current document mode.
function applyModeUI() {
  document.body.classList.toggle("mode-canvas", state.docMode === "canvas");
  document.body.classList.toggle("mode-shot", state.docMode === "screenshot");
  relocateGroups(state.docMode === "canvas");
  resizeCanvas(); // stage height changed when the bottom bar toggled
  // If the active tool isn't valid in this mode, fall back to Select.
  const valid = state.docMode === "canvas"
    ? ["select", "move", "camera", "rect", "ellipse"]
    : ["point", "area", "select"];
  if (!valid.includes(state.mode)) state.mode = "select";
  const btn = document.querySelector(`.mode[data-mode="${state.mode}"]`);
  if (btn) setActive(".mode", btn);
  canvas.style.cursor = cursorForMode();
  document.getElementById("nameGroupLabel").textContent = state.docMode === "canvas" ? "Element" : "Area";
}

// Cursor for the active tool (no automatic hover-based switching).
function cursorForMode() {
  if (state.mode === "select") return "default";
  if (state.mode === "move") return "grab";
  if (state.mode === "camera") return "grab";
  if (state.mode === "rect" || state.mode === "ellipse") return "crosshair";
  return "none"; // point/area use the drawn crosshair overlay
}

function commitPoint() {
  const p = effectivePoint();
  state.shapes.push({
    type: "point", x: p.x, y: p.y,
    label: document.getElementById("areaLabel").value.trim(),
    color: document.getElementById("areaColor").value,
  });
  render();
}

function addAreaVertex() {
  const m = state.mouse;
  if (!state.building) state.building = { pts: [] };
  const pts = state.building.pts;
  const pt = effectivePoint();
  // Click near (or snap onto) the first vertex to close the polygon.
  if (pts.length >= 3) {
    const first = toScreen(state.view, pts[0].x, pts[0].y);
    if (Math.hypot(first.x - m.sx, first.y - m.sy) <= 10 ||
        (pt.x === pts[0].x && pt.y === pts[0].y)) { finishArea(true); return; }
  }
  pts.push(pt);
  render();
}

function finishArea(closed) {
  state.distInput = "";
  updateDistBox();
  if (!state.building || state.building.pts.length < 2) { state.building = null; render(); return; }
  const shape = {
    type: "area",
    pts: state.building.pts,
    closed: closed && state.building.pts.length >= 3,
    name: document.getElementById("areaName").value.trim(),
    label: document.getElementById("areaLabel").value.trim(),
    color: document.getElementById("areaColor").value,
  };
  state.shapes.push(shape);
  state.building = null;
  render();
  if (document.getElementById("autosave").checked) save();
}

// ----- Canvas mode: elements (create / move / resize) -------------------
function styleFromToolbar() {
  return {
    fill: document.getElementById("fillColor").value,
    stroke: document.getElementById("areaColor").value,
    strokeWidth: 1,
    radius: Number(document.getElementById("radius").value) || 0,
  };
}

function nextName(type) {
  const base = { rect: "Rectangle", ellipse: "Ellipse" }[type] || "Item";
  const n = state.shapes.filter(s => s.type === type).length + 1;
  return `${base} ${n}`;
}

// The element currently being dragged out (from state.drag + live cursor).
function draftElement() {
  const d = state.drag;
  const x1 = state.mouse.ix, y1 = state.mouse.iy;
  return {
    type: d.type,
    x: Math.min(d.x0, x1), y: Math.min(d.y0, y1),
    w: Math.abs(x1 - d.x0), h: Math.abs(y1 - d.y0),
    id: nextId(), parent: null,
    name: "", text: "", filled: true, fixed: false, z: nextZ(),
    fontSize: 14, alignH: "center", alignV: "middle", textColor: "#ffffff",
    ...styleFromToolbar(),
  };
}

function commitDraft() {
  const el = draftElement();
  state.drag = null;
  if (el.w < 3 || el.h < 3) { render(); return; } // ignore stray clicks
  el.name = nextName(el.type);
  state.shapes.push(el);
  adoptShape(el);
  selectOnly(state.shapes.length - 1);
  state.mode = "select";           // switch to Select so it can be moved/named
  applyModeUI();
  syncInputsFromSelection();
  render();
  if (document.getElementById("autosave").checked) save();
}

function translateShape(s, dx, dy) {
  if (s.type === "area") s.pts.forEach(p => { p.x += dx; p.y += dy; });
  else { s.x += dx; s.y += dy; }
}

function descendantsOf(c) {
  const out = [];
  const walk = (p) => { for (const k of childrenOf(p)) { out.push(k); if (isContainer(k)) walk(k); } };
  walk(c);
  return out;
}

function translateSubtree(s, dx, dy) {
  translateShape(s, dx, dy);
  if (isContainer(s)) for (const k of descendantsOf(s)) translateShape(k, dx, dy);
}

// ----- Depth (z-order) --------------------------------------------------
const zOf = (s) => s.z || 0;
function topZ() { return state.shapes.reduce((m, s) => Math.max(m, zOf(s)), 0); }
function bottomZ() { return state.shapes.reduce((m, s) => Math.min(m, zOf(s)), 0); }
function nextZ() { return topZ() + 1; }
// Indices sorted back-to-front (asc z); reverse=true gives front-to-back.
function zOrder(reverse) {
  const idx = state.shapes.map((_, i) => i);
  idx.sort((a, b) => zOf(state.shapes[a]) - zOf(state.shapes[b]) || a - b);
  return reverse ? idx.reverse() : idx;
}
function bringFront() {
  const s = state.shapes[state.selected]; if (!s) return;
  s.z = nextZ(); render(); syncPropPanel();
}
function sendBack() {
  const s = state.shapes[state.selected]; if (!s) return;
  s.z = bottomZ() - 1; render(); syncPropPanel();
}

// A name unique among current shapes (appends " 2", " 3"… on collision).
function uniqueName(base) {
  const names = new Set(state.shapes.map(s => s.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

// Insert an SVG icon from the Library at the center of the view.
function insertIcon(src, name) {
  if (!state.ready) return;
  const w = 48, h = 48;
  // center of the currently visible canvas region, in image coords
  let cx = (canvas.clientWidth / 2 - state.view.ox) / state.view.scale;
  let cy = (canvas.clientHeight / 2 - state.view.oy) / state.view.scale;
  if (!isFinite(cx) || !isFinite(cy)) { cx = state.W / 2; cy = state.H / 2; } // zero-sized viewport
  getIconImage(src); // start loading
  state.shapes.push({
    id: nextId(), parent: null, type: "icon", name: uniqueName(name), src,
    x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, fixed: false, z: nextZ(),
  });
  adoptShape(state.shapes[state.shapes.length - 1]);
  relayout();
  selectOnly(state.shapes.length - 1);
  state.mode = "select";
  applyModeUI();
  syncInputsFromSelection();
  render();
  if (document.getElementById("autosave").checked) save();
}

// Insert a UI widget from the library, seeded with its toolkit's default metrics.
function insertWidget(kind, toolkit, at = null) {
  if (!state.ready) return;
  const def = WIDGETS[kind];
  if (!def) return;
  const m = def[toolkit] || def.gtk4;
  let w = m.w, h = m.h;
  // New windows match the existing windows' size (uniform rows in the table).
  if (kind === "window") {
    const first = state.shapes.find(isWindow);
    if (first) { w = first.w; h = first.h; }
  }
  let cx = at?.x ?? (canvas.clientWidth / 2 - state.view.ox) / state.view.scale;
  let cy = at?.y ?? (canvas.clientHeight / 2 - state.view.oy) / state.view.scale;
  if (!isFinite(cx) || !isFinite(cy)) { cx = state.W / 2; cy = state.H / 2; } // zero-sized viewport
  state.shapes.push({
    id: nextId(), parent: null, type: "widget", widget: kind, toolkit,
    name: uniqueName(def.label),
    x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h,
    radius: m.radius || 0, fixed: false, z: nextZ(),
    fontSize: 14, textColor: "#111827",
    ...def.defaults,
    padding: m.padding ? { ...m.padding } : (def.defaults.padding || 0),
  });
  adoptShape(state.shapes[state.shapes.length - 1]);
  relayout();
  selectOnly(state.shapes.length - 1);
  state.mode = "select";
  applyModeUI();
  syncInputsFromSelection();
  render();
  if (document.getElementById("autosave").checked) save();
}

// Add one real widget as a child of a preset. Presets are ordinary editable
// parent/slot trees, not special painted window images.
function addPresetChild(kind, toolkit, parent, slot, overrides = {}) {
  const def = WIDGETS[kind], m = def[toolkit] || def.gtk4;
  const child = {
    id: nextId(), parent: parent.id, slot, type: "widget", widget: kind, toolkit,
    name: uniqueName(overrides.name || def.label),
    x: parent.x, y: parent.y, w: m.w, h: m.h,
    radius: m.radius || 0, fixed: false, z: nextZ(),
    fontSize: 14, textColor: "#111827", ...def.defaults,
    padding: m.padding ? { ...m.padding } : (def.defaults.padding || 0),
    ...overrides,
  };
  state.shapes.push(child);
  return child;
}

// Compose a toolkit window from editable child widgets. Every bar — including
// the title bar — is a real horizontal container the user can rearrange; the
// outer Window only draws the frame. Rows export as normal parent/slot trees.
function composeWindowPreset(win, toolkit) {
  win.toolkit = toolkit;
  win.layout = "vertical";
  win.align = "left";
  win.gap = 0;
  let slot = 0, usedH = 0;

  if (toolkit === "gtk4") {
    // Start.xml is the canonical GNOME default: a single editable header bar,
    // not a titlebar plus a second toolbar. The growing label supplies the
    // flexible middle; every control remains a real movable widget.
    win.padding = 0;
    const tbar = addPresetChild("titlebar", toolkit, win, slot++, {
      name: "Title bar", w: win.w, sizeModeX: "fill", fill: "#f6f5f4",
      align: "left", gap: 6,
    });
    addPresetChild("toolbutton", toolkit, tbar, 0, { name: "ForwordButton", text: "←" });
    addPresetChild("toolbutton", toolkit, tbar, 1, { name: "BackwordsButton", text: "→" });
    addPresetChild("toolbutton", toolkit, tbar, 2, { name: "NewTabButton", text: "＋" });
    addPresetChild("label", toolkit, tbar, 3, {
      name: "Window title", text: win.text || win.name || "Window",
      alignH: "center", sizeModeX: "fill", grow: 1,
    });
    addPresetChild("toolbutton", toolkit, tbar, 4, { name: "Hamburger Menu", text: "☰" });
    addPresetChild("wincontrols", toolkit, tbar, 5, {
      name: "Window buttons", controls: "min,max,close",
    });
    const body = addPresetChild("spacer", toolkit, win, slot++, {
      name: "Start", w: win.w, h: Math.max(1, win.h - tbar.h),
      sizeModeX: "fill", sizeModeY: "fill", grow: 1,
    });
    relayout();
    return body;
  }

  // KDE keeps its traditional titlebar, menubar, toolbar and content rows.
  if (!win.barFill) win.barFill = "#dae0e5";
  // KDE-Window.xml uses full-width chrome rows and a 12px bottom inset only.
  win.padding = { t: 0, r: 0, b: 12, l: 0 };
  const innerW = Math.max(120, win.w);
  const tbar = addPresetChild("titlebar", toolkit, win, slot++, {
    name: "Title bar", w: innerW, sizeModeX: "fill", fill: win.barFill,
    align: "left", gap: 6,
  });
  addPresetChild("spacer", toolkit, tbar, 0, { name: "Start" });
  addPresetChild("label", toolkit, tbar, 1, {
    name: "Window title", text: win.text || win.name || "Window",
    alignH: "center", sizeModeX: "hug",
  });
  addPresetChild("spacer", toolkit, tbar, 2, { name: "End" });
  addPresetChild("wincontrols", toolkit, tbar, 3, {
    name: "Window buttons", controls: "min,max,close",
  });
  usedH += tbar.h;
  const menu = addPresetChild("menubar", toolkit, win, slot++, {
    name: "Menu Bar", w: innerW, sizeModeX: "fill", fill: win.barFill,
  });
  ["File", "Edit", "View", "Help"].forEach((text, i) =>
    addPresetChild("menuitem", toolkit, menu, i, { name: `${text} Menu`, text }));
  usedH += menu.h;
  const tools = addPresetChild("toolbar", toolkit, win, slot++, {
    name: "Main Toolbar", w: innerW, sizeModeX: "fill", fill: win.barFill,
  });
  ["←", "→", "＋"].forEach((text, i) =>
    addPresetChild("toolbutton", toolkit, tools, i, { name: `Tool ${i + 1}`, text }));
  addPresetChild("spacer", toolkit, tools, 3, { name: "Spacer" });
  addPresetChild("searchfield", toolkit, tools, 4, {
    name: "Search field", text: "Search…", sizeModeX: "fixed",
  });
  addPresetChild("toolbutton", toolkit, tools, 5, { name: "Tool 4", text: "☰" });
  usedH += tools.h;
  const content = addPresetChild("section", toolkit, win, slot++, {
    name: "Content", text: "Content", w: innerW,
    h: Math.max(160, win.h - usedH - 12), sizeModeX: "fill", sizeModeY: "fill", grow: 1,
    layout: "vertical", align: "left", gap: 12, overflow: "scroll",
    padding: { t: 18, r: 18, b: 18, l: 18 }, fill: "#ffffff", strokeWidth: 1,
  });
  relayout();
  return content;
}

function insertWindowPreset(toolkit = libToolkit, options = {}) {
  insertWidget("window", toolkit);
  const win = state.shapes[state.selected];
  if (!isWindow(win)) return null;
  win.w = Math.max(160, Number(options.w) || win.w);
  win.h = Math.max(120, Number(options.h) || win.h);
  win.name = uniqueName(options.name || (toolkit === "kde" ? "KDE Window" : "GTK Window"));
  win.text = win.name;
  win.shadow = true; // desktop windows float above the canvas
  win.variantLabel = options.variantLabel || win.name;
  win.variantOf = options.variantOf || null;
  win.barFill = toolkit === "kde" ? "#dae0e5" : win.fill;
  const content = composeWindowPreset(win, toolkit);
  selectOnly(state.shapes.indexOf(content));
  syncInputsFromSelection();
  render();
  if (document.getElementById("autosave").checked) save();
  toast(`Added ${toolkit === "kde" ? "KDE" : "GTK"} window preset`);
  return win;
}

// Clone a complete Window tree as another visible size/state stage. Child names
// intentionally stay identical so a human or AI can compare the same semantic
// widget across variants; ids and parent links are remapped independently.
function cloneWindowVariant(source, options = {}) {
  if (!isWindow(source)) return null;
  const originals = [source, ...descendantsOf(source)];
  const idMap = new Map(originals.filter(s => s.id).map(s => [s.id, nextId()]));
  const rootId = idMap.get(source.id);
  const clones = originals.map((item, index) => {
    const c = JSON.parse(JSON.stringify(item));
    if (c.id) c.id = idMap.get(c.id);
    if (c.parent && idMap.has(c.parent)) c.parent = idMap.get(c.parent);
    c.z = nextZ() + index;
    if (item === source) {
      c.parent = null;
      c.slot = null;
      c.name = uniqueName(options.name || `${source.name || "Window"} variant`);
      c.w = Math.max(160, Number(options.w) || source.w);
      c.h = Math.max(120, Number(options.h) || source.h);
      c.variantOf = source.variantOf || source.id;
      c.variantLabel = options.variantLabel || c.name;
    }
    state.shapes.push(c);
    return c;
  });
  const win = clones.find(c => c.id === rootId) || clones[0];
  relayout();
  selectOnly(state.shapes.indexOf(win));
  state.mode = "select";
  applyModeUI();
  syncInputsFromSelection();
  render();
  if (document.getElementById("autosave").checked) save();
  toast(`Added ${win.variantLabel} from ${source.name || "window"}`);
  return win;
}

// Fetch the asset list and build the Library icon grid (once).
let libraryLoaded = false;
let libraryIcons = [];
function refreshWidgetIconOptions() {
  const select = document.getElementById("ppIcon");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">None</option>' +
    '<option value="__pick__">📂 Choose an asset…</option>' +
    '<option disabled>──────────</option>';
  const user = libraryIcons.filter(ic => ic.src.startsWith("user/"));
  const builtin = libraryIcons.filter(ic => !ic.src.startsWith("user/"));
  const addGroup = (label, items) => {
    if (!items.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const ic of items) {
      const option = document.createElement("option");
      option.value = ic.src; option.textContent = ic.name.replace(/ \(user\)$/, "");
      group.appendChild(option);
    }
    select.appendChild(group);
  };
  addGroup("Your assets", user);
  addGroup("Built-in icons", builtin);
  select.value = libraryIcons.some(ic => ic.src === current) ? current : "";
}
// Upload an external file into the user assets folder and select it.
function pickExternalAsset() {
  const s = state.propOpen !== null ? state.shapes[state.propOpen] : null;
  const select = document.getElementById("ppIcon");
  select.value = (s && (s.widget === "image" ? s.src : s.icon)) || "";
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".png,.svg,.jpg,.jpeg,.webp,image/png,image/svg+xml,image/jpeg,image/webp";
  picker.onchange = async () => {
    const file = picker.files[0];
    if (!file) return;
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
      });
      const resp = await fetch("/assets/upload", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, dataUrl }) });
      const out = await resp.json();
      if (!resp.ok) { toast(out.error || "Upload failed", true); return; }
      const list = await (await fetch("/assets")).json();
      libraryIcons = list.icons || libraryIcons;
      refreshWidgetIconOptions();
      select.value = out.src;
      applyPropPanel();
      toast(`Added ${out.src}`);
    } catch (err) {
      toast(`Upload failed: ${err.message}`, true);
    }
  };
  picker.click();
}

async function loadLibrary() {
  if (libraryLoaded) return;
  libraryLoaded = true;
  const grid = document.getElementById("libGrid");
  try {
    const res = await fetch("/assets");
    const data = await res.json();
    libraryIcons = data.icons || [];
    refreshWidgetIconOptions();
    grid.innerHTML = "";
    for (const ic of libraryIcons) {
      const b = document.createElement("button");
      b.className = "lib-item";
      b.title = ic.name;
      b.dataset.name = ic.name.toLowerCase();
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = "/assets/" + ic.src.split("/").map(encodeURIComponent).join("/");
      b.appendChild(img);
      b.addEventListener("click", () => insertIcon(ic.src, ic.name));
      grid.appendChild(b);
    }
  } catch (err) {
    grid.innerHTML = '<div style="color:var(--muted);font-size:12px">No assets found</div>';
    libraryLoaded = false;
  }
}

// Drag resize handle `handle` of an element to image point (ix, iy).
function resizeElement(s, handle, ix, iy) {
  const before = { x: s.x, y: s.y, w: s.w, h: s.h };
  const kids = isComposite(s) && s.resizeMode === "scale" ? descendantsOf(s) : [];
  const childBefore = kids.map(k => ({ k, x: k.x, y: k.y, w: k.w, h: k.h }));
  let left = s.x, top = s.y, right = s.x + s.w, bottom = s.y + s.h;
  if (handle.includes("w")) left = ix;
  if (handle.includes("e")) right = ix;
  if (handle.includes("n")) top = iy;
  if (handle.includes("s")) bottom = iy;
  s.x = Math.min(left, right); s.y = Math.min(top, bottom);
  s.w = Math.abs(right - left); s.h = Math.abs(bottom - top);
  if (handle.includes("w") || handle.includes("e")) s.sizeModeX = "fixed";
  if (handle.includes("n") || handle.includes("s")) s.sizeModeY = "fixed";
  if (childBefore.length && before.w && before.h) {
    const sx = s.w / before.w, sy = s.h / before.h;
    for (const b of childBefore) {
      b.k.x = s.x + (b.x - before.x) * sx; b.k.y = s.y + (b.y - before.y) * sy;
      b.k.w = Math.max(1, b.w * sx); b.k.h = Math.max(1, b.h * sy);
    }
  }
}

// ----- Section layout (containers arrange their children) ---------------
const isContainer = (s) => s && s.type === "widget" &&
  ["section", "window", "toolbar", "menubar", "titlebar", "splitpane", "composite"].includes(s.widget);
const isComposite = (s) => s && s.type === "widget" && s.widget === "composite";

// The smallest container whose bounds hold this shape's center (its parent).
function parentContainer(s) {
  let best = null, bestArea = Infinity;
  for (const c of state.shapes) {
    if (c === s || !isContainer(c) || !centerIn(s, c)) continue;
    let descendant = false;
    for (let p = c.parent ? byId(c.parent) : null; p; p = p.parent ? byId(p.parent) : null)
      if (p === s) { descendant = true; break; }
    if (descendant) continue;
    const area = Math.abs(c.w * c.h);
    if (area < bestArea) { bestArea = area; best = c; }
  }
  return best;
}

// ----- Explicit parent/slot relationships --------------------------------
// A child's `parent` is its container's id; `slot` is its ordered position.
// Legacy shapes without a parent fall back to geometric containment.
const slotOf = (s) => (s.slot != null ? s.slot : Infinity);
function childrenOf(c) {
  return state.shapes.filter(s =>
    s !== c && isElement(s) && !isWindow(s) &&
    (s.parent != null ? s.parent === c.id : parentContainer(s) === c));
}

function rootWindowOf(s) {
  let current = s;
  while (current?.parent) current = byId(current.parent);
  return isWindow(current) ? current : null;
}

function responsiveVisible(s) {
  for (let current = s; current; current = current.parent ? byId(current.parent) : null) {
    if (current.runtimeVisible === false) return false;
    const win = rootWindowOf(current), width = win ? Number(win.w) || 0 : Infinity;
    if (current.runtimeVisible !== true) {
      if (current.hideBelow > 0 && width < current.hideBelow) return false;
      if (current.showBelow > 0 && width >= current.showBelow) return false;
    }
  }
  return true;
}

function interactionTarget(trigger) {
  const ref = String(trigger?.toggleTarget || "").trim();
  if (!ref) return null;
  const root = rootWindowOf(trigger);
  const scope = root ? [root, ...descendantsOf(root)] : state.shapes;
  const low = ref.toLowerCase();
  return scope.find(s => s.id === ref) || scope.find(s => String(s.name || "").toLowerCase() === low) || null;
}

function interactionTargets(trigger) {
  const root = rootWindowOf(trigger);
  const scope = root ? [root, ...descendantsOf(root)] : state.shapes;
  const refs = [];
  if (trigger?.interactionEnabled && trigger.toggleTarget) refs.push(trigger.toggleTarget);
  const triggerRefs = new Set([String(trigger?.id || "").toLowerCase(), String(trigger?.name || "").toLowerCase()]);
  for (const candidate of scope) {
    if (!candidate.interactionEnabled || !candidate.interactionControl) continue;
    if (triggerRefs.has(String(candidate.interactionControl).toLowerCase())) refs.push(candidate.id || candidate.name);
  }
  return refs.map(ref => {
    const low = String(ref).toLowerCase();
    return scope.find(s => s.id === ref) || scope.find(s => String(s.name || "").toLowerCase() === low);
  }).filter((s, i, all) => s && all.indexOf(s) === i);
}

// Resolve a name/id reference inside the trigger's window (fallback: design).
function resolveInWindow(trigger, ref) {
  const clean = String(ref || "").trim();
  if (!clean) return null;
  const root = rootWindowOf(trigger);
  const scope = root ? [root, ...descendantsOf(root)] : state.shapes;
  const low = clean.toLowerCase();
  return scope.find(s => s.id === clean) || scope.find(s => String(s.name || "").toLowerCase() === low) || null;
}

// Declarative UI action on a control: action (toggle|show|hide|switch) + target.
// `switch` shows the target and hides its sibling sections — content-pane
// navigation. Purely UI-level; anything else belongs in application code.
function performUiAction(trigger) {
  const act = trigger?.action && trigger.action !== "none" ? trigger.action : null;
  if (!act) return false;
  const target = resolveInWindow(trigger, trigger.target);
  if (!target) { toast(`No action target "${trigger.target || ""}"`, true); return true; }
  if (act === "toggle") target.runtimeVisible = responsiveVisible(target) ? false : true;
  else if (act === "show") target.runtimeVisible = true;
  else if (act === "hide") target.runtimeVisible = false;
  else if (act === "switch") {
    target.runtimeVisible = true;
    const parent = target.parent ? byId(target.parent) : null;
    if (parent) for (const sib of childrenOf(parent))
      if (sib !== target && sib.widget === "section") sib.runtimeVisible = false;
  }
  relayout(); render();
  toast(`${act} → ${target.name || target.id}: ${responsiveVisible(target) ? "shown" : "hidden"}`);
  return true;
}

function toggleInteractionTarget(trigger) {
  if (performUiAction(trigger)) return true;
  const targets = interactionTargets(trigger);
  if (!targets.length) { toast(`No hide/show interaction for "${trigger?.name || "element"}"`, true); return false; }
  for (const target of targets) target.runtimeVisible = responsiveVisible(target) ? false : true;
  relayout(); render();
  toast(targets.map(target => `${target.name || target.id}: ${responsiveVisible(target) ? "shown" : "hidden"}`).join(" · "));
  return true;
}

// Adopt a dropped/inserted element into the container under its center,
// inserting it at the slot matching its drop position among the siblings.
function adoptShape(s) {
  if (!isElement(s) || isWindow(s)) return null;
  const c = parentContainer(s);
  s.parent = c ? c.id : null;
  if (!c) { s.slot = null; return null; }
  const layout = c.layout || "vertical";
  const key = (k) => (layout === "horizontal" ? k.x + k.w / 2 : k.y + k.h / 2);
  const sibs = childrenOf(c).filter(k => k !== s).sort((a, b) => slotOf(a) - slotOf(b) || key(a) - key(b));
  let idx = sibs.findIndex(k => key(s) < key(k));
  if (idx < 0) idx = sibs.length;
  sibs.splice(idx, 0, s);
  sibs.forEach((k, i) => { k.slot = i; });
  return c;
}

function dropHintAt(p, moving = null) {
  const candidates = state.shapes.filter(c => {
    if (!isContainer(c) || c === moving) return false;
    if (p.x < c.x || p.x > c.x + c.w || p.y < c.y || p.y > c.y + c.h) return false;
    for (let q = c.parent ? byId(c.parent) : null; q; q = q.parent ? byId(q.parent) : null) if (q === moving) return false;
    return true;
  }).sort((a, b) => a.w * a.h - b.w * b.h);
  const c = candidates[0]; if (!c) return null;
  const layout = c.layout || "vertical", v = containerViewport(c);
  const kids = childrenOf(c).filter(k => k !== moving).sort((a, b) => slotOf(a) - slotOf(b));
  const key = layout === "horizontal" ? p.x : p.y;
  let slot = kids.findIndex(k => key < (layout === "horizontal" ? k.x + k.w / 2 : k.y + k.h / 2));
  if (slot < 0) slot = kids.length;
  let line;
  if (layout === "horizontal") {
    const x = slot < kids.length ? kids[slot].x : kids.length ? kids[kids.length - 1].x + kids[kids.length - 1].w : v.x;
    line = { x1: x, y1: v.y, x2: x, y2: v.y + v.h };
  } else {
    const y = slot < kids.length ? kids[slot].y : kids.length ? kids[kids.length - 1].y + kids[kids.length - 1].h : v.y;
    line = { x1: v.x, y1: y, x2: v.x + v.w, y2: y };
  }
  return { container: c, slot, line };
}

const bounded = (value, min, max) => Math.max(min || 1, max > 0 ? Math.min(max, value) : value);
const percentage = (s, axis) => Math.max(0, Math.min(100,
  Number(axis === "x" ? s.widthPercent : s.heightPercent) || 0));

// Approximate a widget's natural content size. Toolkit registry metrics remain
// the floor, while text can expand it. This is deterministic and exportable;
// native GTK/Qt can refine the final measurement after code generation.
function hugDimensions(s, seen = new Set()) {
  if (seen.has(s)) return { w: s.w || 1, h: s.h || 1 };
  seen.add(s);
  const def = s.type === "widget" ? WIDGETS[s.widget] : null;
  const metric = def && (def[s.toolkit] || def.gtk4);
  const P = side4(s.padding);
  const fs = s.fontSize || 14;
  const textW = s.text && s.showText !== false ? Math.ceil(String(s.text).length * fs * 0.62) : 0;
  let w = Math.max(metric?.w || 24, textW + P.l + P.r + 16);
  const availableTextW = Math.max(1, (s.w || w) - P.l - P.r - 16);
  const lineCount = s.textOverflow === "wrap" && s.text
    ? Math.max(1, Math.ceil(textW / availableTextW)) : 1;
  let h = Math.max(metric?.h || 18, fs * 1.45 * lineCount + P.t + P.b);
  if (isContainer(s)) {
    const kids = childrenOf(s).filter(k => !k.fixed).sort((a, b) => slotOf(a) - slotOf(b));
    if (kids.length) {
      // A hug container follows its content; the library's default size is a
      // starting metric for empty insertion, not a minimum.
      w = Math.max(24, textW + P.l + P.r + 16);
      h = P.t + P.b + containerHeadOffset(s);
      const gap = Number(s.gap != null ? s.gap : 12) || 0;
      const boxes = kids.map(k => {
        const natural = hugDimensions(k, new Set(seen)), M = side4(k.margin);
        const kw = k.sizeModeX === "hug" ? natural.w : k.w;
        const kh = k.sizeModeY === "hug" ? natural.h : k.h;
        return { w: M.l + kw + M.r, h: M.t + kh + M.b };
      });
      if ((s.layout || "vertical") === "horizontal") {
        w = Math.max(w, boxes.reduce((n, b) => n + b.w, 0) + gap * (boxes.length - 1) + P.l + P.r);
        h = Math.max(h, Math.max(...boxes.map(b => b.h)) + P.t + P.b + containerHeadOffset(s));
      } else if ((s.layout || "vertical") === "table") {
        const cols = Math.max(1, Number(s.cols) || 1), rows = Math.ceil(boxes.length / cols);
        w = Math.max(w, Math.max(...boxes.map(b => b.w)) * cols + gap * (cols - 1) + P.l + P.r);
        h = Math.max(h, Math.max(...boxes.map(b => b.h)) * rows + gap * (rows - 1) + P.t + P.b + containerHeadOffset(s));
      } else {
        w = Math.max(w, Math.max(...boxes.map(b => b.w)) + P.l + P.r);
        h = Math.max(h, boxes.reduce((n, b) => n + b.h, 0) + gap * (boxes.length - 1) + P.t + P.b + containerHeadOffset(s));
      }
    }
  }
  return { w: bounded(w, s.minW, s.maxW), h: bounded(h, s.minH, s.maxH) };
}

function prepareLayoutSize(s) {
  const hug = hugDimensions(s);
  if (s.sizeModeX === "hug") s.w = hug.w;
  if (s.sizeModeY === "hug") s.h = hug.h;
  s.w = bounded(s.w, s.minW, s.maxW);
  s.h = bounded(s.h, s.minH, s.maxH);
}

function distributedMain(justify, free, count, baseGap) {
  const j = normalizeJustify(justify), room = Math.max(0, free);
  if (j === "center") return { lead: room / 2, gap: baseGap };
  if (j === "end") return { lead: room, gap: baseGap };
  if (j === "space-between" && count > 1) return { lead: 0, gap: baseGap + room / (count - 1) };
  if (j === "space-around" && count > 0) {
    const extra = room / count; return { lead: extra / 2, gap: baseGap + extra };
  }
  if (j === "space-evenly" && count > 0) {
    const extra = room / (count + 1); return { lead: extra, gap: baseGap + extra };
  }
  return { lead: 0, gap: baseGap };
}

// Reposition direct children per layout, sizing rules, margins and slots.
// fixed children remain absolute. Fill/grow and percentage sizing operate on
// the layout's main axis; wrap starts a new row/column; table honors spans.
function arrangeInto(c) {
  const P = side4(c.padding, 12), gap = c.gap != null ? c.gap : 12;
  const align = normalizeAlign(c.align), layout = c.layout || "vertical";
  const headOffset = containerHeadOffset(c);
  const top = c.y + P.t + headOffset, left = c.x + P.l;
  const innerW = Math.max(1, c.w - P.l - P.r);
  const innerH = Math.max(1, c.h - P.t - P.b - headOffset);
  const managed = childrenOf(c).filter(s => !s.fixed);
  managed.sort((a, b) => slotOf(a) - slotOf(b) || a.y - b.y || a.x - b.x);
  managed.forEach((k, i) => { k.slot = i; });
  const kids = managed.filter(responsiveVisible);
  if (!kids.length) return 0;
  kids.forEach(prepareLayoutSize);

  const alignX = (k, M, width = innerW) => align === "center" ? left + (width - k.w) / 2
    : align === "end" ? left + width - k.w - M.r : left + M.l;
  const alignY = (k, M, height = innerH) => align === "center" ? top + (height - k.h) / 2
    : align === "end" ? top + height - k.h - M.b : top + M.t;

  if (layout === "horizontal") {
    if (!c.wrap) {
      const percentKids = kids.filter(k => k.sizeModeX === "percent");
      const flex = kids.filter(k => k.sizeModeX !== "percent" && ((k.grow || 0) > 0 || k.sizeModeX === "fill"));
      const marginsAndGaps = kids.reduce((sum, k) => {
        const M = side4(k.margin); return sum + M.l + M.r;
      }, 0) + gap * Math.max(0, kids.length - 1);
      const fixedW = kids.filter(k => !percentKids.includes(k) && !flex.includes(k))
        .reduce((sum, k) => sum + k.w, 0);
      const available = Math.max(0, innerW - marginsAndGaps - fixedW);
      const bases = flex.reduce((sum, k) => sum + (k.minW || 1), 0);
      const percentSpace = Math.max(0, available - bases);
      const percentTotal = percentKids.reduce((sum, k) => sum + percentage(k, "x"), 0);
      const percentScale = percentTotal > 100 ? 100 / percentTotal : 1;
      for (const k of percentKids)
        k.w = bounded(percentSpace * percentage(k, "x") * percentScale / 100, k.minW, k.maxW);
      const percentUsed = percentKids.reduce((sum, k) => sum + k.w, 0);
      const room = Math.max(0, available - percentUsed - bases);
      const weight = flex.reduce((sum, k) => sum + Math.max(0.001, k.grow || 1), 0);
      for (const k of flex) k.w = bounded((k.minW || 1) + room * Math.max(0.001, k.grow || 1) / weight, k.minW, k.maxW);
    } else {
      for (const k of kids) if (k.sizeModeX === "percent")
        k.w = bounded(innerW * percentage(k, "x") / 100, k.minW, k.maxW);
    }
    const usedW = kids.reduce((sum, k) => { const M = side4(k.margin); return sum + M.l + k.w + M.r; }, 0)
      + gap * Math.max(0, kids.length - 1);
    const dist = c.wrap ? { lead: 0, gap } : distributedMain(c.justify, innerW - usedW, kids.length, gap);
    let x = left + dist.lead, y = top, lineH = 0;
    for (const k of kids) {
      const M = side4(k.margin), totalW = M.l + k.w + M.r;
      if (c.wrap && x > left && x + totalW > left + innerW) { x = left; y += lineH + gap; lineH = 0; }
      if ((k.sizeModeY === "fill" || align === "stretch") && !c.wrap) k.h = bounded(innerH - M.t - M.b, k.minH, k.maxH);
      else if (k.sizeModeY === "percent") k.h = bounded((innerH - M.t - M.b) * percentage(k, "y") / 100, k.minH, k.maxH);
      k.x = Math.round(x + M.l); k.y = Math.round(c.wrap ? y + M.t : alignY(k, M));
      x += totalW + dist.gap; lineH = Math.max(lineH, M.t + k.h + M.b);
    }
  } else if (layout === "table") {
    const cols = Math.max(1, Math.round(c.cols || Math.ceil(Math.sqrt(kids.length))));
    const colW = (innerW - gap * (cols - 1)) / cols;
    const occupied = [], placements = [], rowHeights = [];
    const fits = (row, col, rs, cs) => col + cs <= cols && [...Array(rs)].every((_, rr) =>
      [...Array(cs)].every((__, cc) => !occupied[row + rr]?.[col + cc]));
    for (const k of kids) {
      const cs = Math.min(cols, Math.max(1, Math.round(k.colSpan || 1)));
      const rs = Math.max(1, Math.round(k.rowSpan || 1));
      let row = 0, col = 0;
      while (!fits(row, col, rs, cs)) { if (++col >= cols) { col = 0; row++; } }
      for (let rr = 0; rr < rs; rr++) for (let cc = 0; cc < cs; cc++) {
        occupied[row + rr] ||= []; occupied[row + rr][col + cc] = true;
      }
      const M = side4(k.margin);
      const cellW = colW * cs + gap * (cs - 1);
      if (k.sizeModeX === "fill") k.w = bounded(cellW - M.l - M.r, k.minW, k.maxW);
      else if (k.sizeModeX === "percent") k.w = bounded((cellW - M.l - M.r) * percentage(k, "x") / 100, k.minW, k.maxW);
      rowHeights[row] = Math.max(rowHeights[row] || 0, (M.t + k.h + M.b - gap * (rs - 1)) / rs);
      placements.push({ k, row, col, rs, cs, M, cellW });
    }
    const rowY = []; let yy = top;
    for (let r = 0; r < rowHeights.length; r++) { rowY[r] = yy; yy += (rowHeights[r] || 1) + gap; }
    for (const p of placements) {
      const cellH = [...Array(p.rs)].reduce((sum, _, i) => sum + (rowHeights[p.row + i] || 1), 0) + gap * (p.rs - 1);
      if (p.k.sizeModeY === "fill") p.k.h = bounded(cellH - p.M.t - p.M.b, p.k.minH, p.k.maxH);
      else if (p.k.sizeModeY === "percent") p.k.h = bounded((cellH - p.M.t - p.M.b) * percentage(p.k, "y") / 100, p.k.minH, p.k.maxH);
      const cellX = left + p.col * (colW + gap);
      if (align === "stretch" && p.k.sizeModeX !== "fixed") p.k.w = bounded(p.cellW - p.M.l - p.M.r, p.k.minW, p.k.maxW);
      p.k.x = Math.round(p.k.sizeModeX === "fill" || align === "start" || align === "stretch" ? cellX + p.M.l
        : align === "center" ? cellX + (p.cellW - p.k.w) / 2 : cellX + p.cellW - p.k.w - p.M.r);
      p.k.y = Math.round(rowY[p.row] + p.M.t);
    }
  } else {
    if (!c.wrap) {
      const percentKids = kids.filter(k => k.sizeModeY === "percent");
      const flex = kids.filter(k => k.sizeModeY !== "percent" && ((k.grow || 0) > 0 || k.sizeModeY === "fill"));
      const marginsAndGaps = kids.reduce((sum, k) => {
        const M = side4(k.margin); return sum + M.t + M.b;
      }, 0) + gap * Math.max(0, kids.length - 1);
      const fixedH = kids.filter(k => !percentKids.includes(k) && !flex.includes(k))
        .reduce((sum, k) => sum + k.h, 0);
      const available = Math.max(0, innerH - marginsAndGaps - fixedH);
      const bases = flex.reduce((sum, k) => sum + (k.minH || 1), 0);
      const percentSpace = Math.max(0, available - bases);
      const percentTotal = percentKids.reduce((sum, k) => sum + percentage(k, "y"), 0);
      const percentScale = percentTotal > 100 ? 100 / percentTotal : 1;
      for (const k of percentKids)
        k.h = bounded(percentSpace * percentage(k, "y") * percentScale / 100, k.minH, k.maxH);
      const percentUsed = percentKids.reduce((sum, k) => sum + k.h, 0);
      const room = Math.max(0, available - percentUsed - bases);
      const weight = flex.reduce((sum, k) => sum + Math.max(0.001, k.grow || 1), 0);
      for (const k of flex) k.h = bounded((k.minH || 1) + room * Math.max(0.001, k.grow || 1) / weight, k.minH, k.maxH);
    } else {
      for (const k of kids) if (k.sizeModeY === "percent")
        k.h = bounded(innerH * percentage(k, "y") / 100, k.minH, k.maxH);
    }
    const usedH = kids.reduce((sum, k) => { const M = side4(k.margin); return sum + M.t + k.h + M.b; }, 0)
      + gap * Math.max(0, kids.length - 1);
    const dist = c.wrap ? { lead: 0, gap } : distributedMain(c.justify, innerH - usedH, kids.length, gap);
    let x = left, y = top + dist.lead, lineW = 0;
    for (const k of kids) {
      const M = side4(k.margin), totalH = M.t + k.h + M.b;
      if (c.wrap && y > top && y + totalH > top + innerH) { y = top; x += lineW + gap; lineW = 0; }
      if ((k.sizeModeX === "fill" || align === "stretch") && !c.wrap) k.w = bounded(innerW - M.l - M.r, k.minW, k.maxW);
      else if (k.sizeModeX === "percent") k.w = bounded((innerW - M.l - M.r) * percentage(k, "x") / 100, k.minW, k.maxW);
      k.x = Math.round(c.wrap ? x + M.l : alignX(k, M)); k.y = Math.round(y + M.t);
      y += totalH + dist.gap; lineW = Math.max(lineW, M.l + k.w + M.r);
    }
  }
  // Derive overflow extents from laid-out content. Scroll offsets are applied
  // physically so hit-testing, selection and nested layouts use the same data.
  const maxRight = Math.max(...kids.map(k => k.x + k.w + side4(k.margin).r), left);
  const maxBottom = Math.max(...kids.map(k => k.y + k.h + side4(k.margin).b), top);
  c.scrollMaxX = Math.max(0, Math.ceil(maxRight - (left + innerW)));
  c.scrollMaxY = Math.max(0, Math.ceil(maxBottom - (top + innerH)));
  if (c.overflow === "scroll") {
    // A bound fixed Scrollbar controls its direct parent. Horizontal/vertical
    // orientation is inferred from the scrollbar's shape.
    for (const bar of childrenOf(c).filter(k => k.widget === "scrollbar" && k.bindScroll)) {
      bar.fixed = true;
      const ratio = Math.max(0, Math.min(100, bar.value || 0)) / 100;
      if (bar.h > bar.w) c.scrollY = Math.round(c.scrollMaxY * ratio);
      else c.scrollX = Math.round(c.scrollMaxX * ratio);
    }
    c.scrollX = Math.max(0, Math.min(c.scrollMaxX, Number(c.scrollX) || 0));
    c.scrollY = Math.max(0, Math.min(c.scrollMaxY, Number(c.scrollY) || 0));
    if (c.scrollX || c.scrollY) for (const k of kids) translateShape(k, -c.scrollX, -c.scrollY);
  } else {
    c.scrollX = 0; c.scrollY = 0;
  }
  return kids.length;
}

// Manual "Arrange children" button (kept for containers with layout "none").
function arrangeChildren(c) {
  if (!isContainer(c)) { toast("Select a Section or Window to arrange", true); return; }
  const n = arrangeInto(c);
  render();
  toast(n ? `Arranged ${n} element(s) — ${c.layout || "vertical"}` : "No elements inside to arrange");
}

// ----- Automatic layout pass ---------------------------------------------
// Windows are managed: they stack vertically (top→bottom) and can't be
// dragged — their size is edited from the properties panel.
const WIN_MARGIN = 60, WIN_GAP = 60; // outer margin + spacing between rows
function layoutWindows() {
  const wins = state.shapes.filter(isWindow);
  let y = WIN_MARGIN, maxRight = 0;
  for (const w of wins) {
    // Root windows honor their explicit minimum/maximum just like managed
    // children. This lets an app design declare a safe desktop size that the
    // properties panel, resize command, and responsive-variant copy cannot cross.
    prepareLayoutSize(w);
    const dx = WIN_MARGIN - w.x, dy = y - w.y;
    if (dx || dy) {
      // Children travel with their window.
      const kids = state.shapes.filter(s => s !== w && isElement(s) && !isWindow(s) && centerIn(s, w));
      w.x = WIN_MARGIN; w.y = y;
      for (const k of kids) translateShape(k, dx, dy);
    }
    y += w.h + WIN_GAP;
    maxRight = Math.max(maxRight, w.x + w.w);
  }
  // The document extent is the table of windows (one column), not a fixed canvas.
  if (wins.length) {
    state.W = Math.round(maxRight + WIN_MARGIN);
    state.H = Math.round(y - WIN_GAP + WIN_MARGIN);
  }
}

// Run after any structural change: stack windows, then arrange every
// container that has an active layout (containers with "none" stay manual).
// Outer containers first (windows, then biggest→smallest sections) so a
// nested section is positioned by its parent before placing its own children.
function relayout() {
  if (state.docMode !== "canvas") return;
  layoutWindows();
  // A container with no explicit layout auto-arranges vertically (matching
  // arrangeInto's own `c.layout || "vertical"`); only "none" opts out.
  const cs = state.shapes.filter(c => isContainer(c) && c.layout !== "none");
  cs.sort((a, b) => (isWindow(b) ? 1 : 0) - (isWindow(a) ? 1 : 0) || b.w * b.h - a.w * a.h);
  // Nested hug sizes can change an ancestor, which in turn changes wrapped
  // descendants. A few deterministic passes converge the tree without making
  // layout depend on selection or paint timing.
  for (let pass = 0; pass < 4; pass++) {
    for (const c of [...cs].reverse()) prepareLayoutSize(c);
    layoutWindows();
    for (const c of cs) arrangeInto(c);
  }
  refreshTree();
}

// ----- Typed distance (AutoCAD-style) -----------------------------------
function updateDistBox() {
  const el = document.getElementById("distBox");
  if (state.distInput) {
    el.textContent = state.distInput + " px ⏎";
    el.style.left = (state.mouse.sx + 18) + "px";
    el.style.top = (state.mouse.sy + 18) + "px";
    el.classList.add("show");
  } else {
    el.classList.remove("show");
  }
}

// Place the next vertex at the typed distance along the current aim direction.
function commitTypedDistance() {
  const d = parseFloat(state.distInput);
  state.distInput = "";
  updateDistBox();
  const b = state.building;
  if (!b || !b.pts.length || !isFinite(d) || d <= 0) return;
  const last = b.pts[b.pts.length - 1];
  const aim = applySnap(last, { x: state.mouse.ix, y: state.mouse.iy });
  const dx = aim.x - last.x, dy = aim.y - last.y;
  const len = Math.hypot(dx, dy);
  if (!len) return;
  b.pts.push({ x: Math.round(last.x + (dx / len) * d), y: Math.round(last.y + (dy / len) * d) });
  render();
}

// ----- Equalize segment lengths ------------------------------------------
// Rebuild the selected area so every segment has the average length, keeping
// each segment's direction. Closed shapes distribute the closure error across
// the vertices (surveyor's compass rule) so the polygon still closes.
function equalizeSelected() {
  const s = state.selected !== null ? state.shapes[state.selected] : null;
  if (!s || s.type !== "area" || s.pts.length < 3) {
    toast("Select an area first (☝ Select mode)", true);
    return;
  }
  const pts = s.pts;
  const n = s.closed ? pts.length : pts.length - 1;
  let total = 0;
  const dirs = [];
  const step = Math.PI / 4, straightenTol = (12 * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    total += dist(a, b);
    let dir = Math.atan2(b.y - a.y, b.x - a.x);
    // Straighten near-axis segments (within 12° of a 45° multiple) so
    // "parallel" sides become truly parallel and the shape can close exactly.
    const snapped = Math.round(dir / step) * step;
    if (Math.abs(dir - snapped) <= straightenTol) dir = snapped;
    dirs.push(dir);
  }
  const L = total / n;
  const np = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 0; i < n; i++) {
    np.push({ x: np[i].x + L * Math.cos(dirs[i]), y: np[i].y + L * Math.sin(dirs[i]) });
  }
  if (s.closed) {
    const rx = np[n].x - np[0].x, ry = np[n].y - np[0].y; // closure error
    for (let i = 1; i < n; i++) { np[i].x -= rx * (i / n); np[i].y -= ry * (i / n); }
    np.pop();
  }
  s.pts = np.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  render();
  toast(`Segments equalized to ~${Math.round(L)} px`);
}

function undo() {
  if (state.building && state.building.pts.length) {
    state.building.pts.pop();
    if (!state.building.pts.length) state.building = null;
  } else {
    state.shapes.pop();
    clearSelection();
    closeProps();
  }
  render();
}

function clearAll() {
  state.shapes = [];
  state.editComposite = null;
  state.building = null;
  clearSelection();
  closeProps();
  render();
}

// ----- Selecting & per-shape editing -----------------------------------
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Return the index of the topmost shape under image-space point `p`, or null.
function hitTest(p) {
  const tol = 8 / state.view.scale; // ~8 screen px, in image units
  for (const i of zOrder(true)) { // front-to-back
    const s = state.shapes[i];
    if (isElement(s) && !responsiveVisible(s)) continue;
    if (isElement(s) && !pointInsideOverflowAncestors(s, p)) continue;
    if (s.type === "point") {
      if (dist(p, s) <= Math.max(tol, 6)) return selectionIndexFor(s, i);
    } else if (s.type === "rect" || s.type === "icon" || s.type === "widget") {
      const bb = shapeBBox(s);
      if (p.x >= bb.x - tol && p.x <= bb.x + bb.w + tol &&
          p.y >= bb.y - tol && p.y <= bb.y + bb.h + tol) return selectionIndexFor(s, i);
    } else if (s.type === "ellipse") {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const rx = Math.abs(s.w / 2) + tol, ry = Math.abs(s.h / 2) + tol;
      if (rx > 0 && ry > 0 &&
          ((p.x - cx) ** 2) / (rx * rx) + ((p.y - cy) ** 2) / (ry * ry) <= 1) return selectionIndexFor(s, i);
    } else {
      const pts = s.pts;
      if (s.closed && pts.length >= 3 && pointInPolygon(p, pts)) return selectionIndexFor(s, i);
      const n = s.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < n; k++) {
        if (distToSegment(p, pts[k], pts[(k + 1) % pts.length]) <= tol) return selectionIndexFor(s, i);
      }
    }
  }
  return null;
}

function pointInsideOverflowAncestors(s, p) {
  let c = s.parent ? byId(s.parent) : null;
  while (c) {
    if (isComposite(c)) {
      const r = cornerRadii(c), x = p.x - c.x, y = p.y - c.y;
      if (x < 0 || y < 0 || x > c.w || y > c.h) return false;
      const outside = (cx, cy, rr) => rr > 0 && (x - cx) ** 2 + (y - cy) ** 2 > rr ** 2;
      if ((x < r.tl && y < r.tl && outside(r.tl, r.tl, r.tl)) ||
          (x > c.w - r.tr && y < r.tr && outside(c.w - r.tr, r.tr, r.tr)) ||
          (x > c.w - r.br && y > c.h - r.br && outside(c.w - r.br, c.h - r.br, r.br)) ||
          (x < r.bl && y > c.h - r.bl && outside(r.bl, c.h - r.bl, r.bl))) return false;
    }
    if (["clip", "scroll"].includes(c.overflow)) {
      const v = containerViewport(c);
      if (p.x < v.x || p.x > v.x + v.w || p.y < v.y || p.y > v.y + v.h) return false;
    }
    c = c.parent ? byId(c.parent) : null;
  }
  return true;
}

function selectionIndexFor(s, fallback) {
  let owner = null;
  for (let p = s.parent ? byId(s.parent) : null; p; p = p.parent ? byId(p.parent) : null) {
    if (isComposite(p) && p.id !== state.editComposite) owner = p;
  }
  return owner ? state.shapes.indexOf(owner) : fallback;
}

// Selection helpers — keep `selection` (all) and `selected` (primary) in sync.
function selectOnly(i) {
  if (i === null || i === undefined) { state.selection = []; state.selected = null; closeProps(); }
  else {
    state.selection = [i]; state.selected = i; syncInputsFromSelection();
    syncPropsToSelection();
  }
}
function clearSelection() { state.selection = []; state.selected = null; closeProps(); }
function toggleInSelection(i) {
  const at = state.selection.indexOf(i);
  if (at >= 0) state.selection.splice(at, 1);
  else state.selection.push(i);
  state.selected = state.selection.length ? state.selection[state.selection.length - 1] : null;
  if (state.selected !== null) syncInputsFromSelection();
  syncPropsToSelection();
}
// The sidebar properties panel follows the primary selection (canvas mode).
function syncPropsToSelection() {
  if (state.docMode === "canvas" && state.selected !== null && isElement(state.shapes[state.selected]))
    openProps(state.selected);
  else closeProps();
  refreshTree(); // keep the tree's selection highlight in sync
}

function selectAt(sx, sy) {
  selectOnly(hitTest(screenToImage(sx, sy)));
  render();
}

const isElement = (s) => s && (s.type === "rect" || s.type === "ellipse" || s.type === "icon" || s.type === "widget");

// The Properties panel must display the same fallback alignment the renderer
// uses. Without this, an unset Section looked top-left while the controls
// misleadingly showed center/middle.
function defaultTextAlign(s) {
  if (!s || s.type !== "widget") return { h: "center", v: "middle" };
  if (s.widget === "section") return { h: "left", v: "top" };
  if (s.widget === "window") return { h: s.toolkit === "kde" ? "left" : "center", v: "middle" };
  if (["textbox", "label", "checkbox", "radio", "dropdown", "list", "menubar", "statusbar",
       "breadcrumb", "searchfield", "file", "storage"].includes(s.widget)) return { h: "left", v: "middle" };
  return { h: "center", v: "middle" };
}

// Widget library: per-toolkit default metrics (from libraries.md) + style/state
// defaults. Registry-driven so new widgets are one entry.
const WIDGET_CATS = ["Sections", "Input", "Navigation", "Output", "Backend"];
const WIDGETS = {
  // ----- Sections / containers -----
  window:   { label: "Window",   cat: "Sections", gtk4: { w: 600, h: 400, radius: 12 }, kde: { w: 600, h: 400, radius: 4 },
              defaults: { text: "Window", fill: "#ffffff", stroke: "#c9ced6", strokeWidth: 1, textColor: "#111827" } },
  // Sections are pure layout containers — no text of their own by default.
  // Want a title? Place a Label child, or enable the caption explicitly.
  section:  { label: "Section",  cat: "Sections", gtk4: { w: 240, h: 160, radius: 8 }, kde: { w: 240, h: 160, radius: 4 },
              defaults: { text: "", showCaption: false, fill: "none", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#6b7280" } },
  // ----- Input -----
  button:   { label: "Button",   cat: "Input", gtk4: { w: 120, h: 34, radius: 8, padding: { t: 6, r: 12, b: 6, l: 12 } }, kde: { w: 110, h: 30, radius: 4, padding: { t: 4, r: 8, b: 4, l: 8 } },
              defaults: { text: "Button", fill: "#e7eaee", stroke: "#c9ced6", strokeWidth: 1, textColor: "#111827", alignH: "center", iconSize: 18, iconPosition: "left", iconGap: 6 } },
  textbox:  { label: "Textbox",  cat: "Input", gtk4: { w: 220, h: 34, radius: 8 }, kde: { w: 220, h: 30, radius: 3 },
              defaults: { text: "Enter text…", fill: "#ffffff", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#6b7280", alignH: "left", iconSize: 16, iconPosition: "right", iconGap: 6 } },
  checkbox: { label: "Checkbox", cat: "Input", gtk4: { w: 150, h: 22, radius: 4 }, kde: { w: 150, h: 20, radius: 3 },
              defaults: { text: "Checkbox", fill: "#4a9eff", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#111827", checked: true } },
  radio:    { label: "Radio",    cat: "Input", gtk4: { w: 150, h: 22, radius: 11 }, kde: { w: 150, h: 20, radius: 10 },
              defaults: { text: "Option", fill: "#4a9eff", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#111827", checked: true } },
  toggle:   { label: "Toggle",   cat: "Input", gtk4: { w: 48, h: 24, radius: 12 }, kde: { w: 44, h: 22, radius: 11 },
              defaults: { fill: "#4a9eff", stroke: "#c9ced6", strokeWidth: 1, on: true } },
  slider:   { label: "Slider",   cat: "Input", gtk4: { w: 200, h: 20, radius: 0 }, kde: { w: 200, h: 18, radius: 0 },
              defaults: { fill: "#4a9eff", stroke: "#c9ced6", strokeWidth: 3, value: 60 } },
  dropdown: { label: "Dropdown", cat: "Input", gtk4: { w: 200, h: 34, radius: 8 }, kde: { w: 200, h: 30, radius: 3 },
              defaults: { text: "Select…", fill: "#ffffff", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#6b7280", alignH: "left" } },
  scrollbar:{ label: "Scrollbar",cat: "Input", gtk4: { w: 220, h: 12, radius: 6 }, kde: { w: 220, h: 14, radius: 3 },
              defaults: { value: 30, interactionEnabled: true, fill: "#dfe3e8", thumbFill: "#7b8490", stroke: "#c9ced6", strokeWidth: 0 } },
  // ----- Navigation / window chrome -----
  menubar:  { label: "Menubar",  cat: "Navigation", gtk4: { w: 360, h: 32, radius: 0 }, kde: { w: 360, h: 26, radius: 0 },
              defaults: { text: "", fill: "#f1f3f5", stroke: "#c9ced6", strokeWidth: 1, textColor: "#111827", layout: "horizontal", align: "left", gap: 4, padding: { t: 2, r: 6, b: 2, l: 6 } } },
  toolbar:  { label: "Toolbar",  cat: "Navigation", gtk4: { w: 360, h: 42, radius: 0 }, kde: { w: 360, h: 36, radius: 0 },
              defaults: { count: 5, fill: "#f1f3f5", stroke: "#c9ced6", strokeWidth: 1, textColor: "#59636e", layout: "horizontal", align: "left", gap: 6, padding: { t: 4, r: 8, b: 4, l: 8 } } },
  menuitem: { label: "Menu item", cat: "Navigation", gtk4: { w: 52, h: 28, radius: 4 }, kde: { w: 48, h: 22, radius: 2 },
              defaults: { text: "Menu", fill: "none", stroke: "#000000", strokeWidth: 0, textColor: "#111827", iconSize: 16, iconPosition: "left", iconGap: 5 } },
  toolbutton:{ label: "Tool button", cat: "Navigation", gtk4: { w: 30, h: 30, radius: 6, padding: { t: 6, r: 6, b: 6, l: 6 } }, kde: { w: 28, h: 26, radius: 3, padding: { t: 4, r: 5, b: 4, l: 5 } },
              defaults: { text: "+", fill: "#e7eaee", stroke: "#c9ced6", strokeWidth: 0, textColor: "#59636e", iconSize: 18, iconPosition: "only", iconGap: 4 } },
  separator:{ label: "Separator", cat: "Navigation", gtk4: { w: 8, h: 28, radius: 0 }, kde: { w: 8, h: 24, radius: 0 },
              defaults: { fill: "none", stroke: "#9aa1ac", strokeWidth: 1, lines: 1 } },
  spacer:   { label: "Spacer",    cat: "Navigation", gtk4: { w: 40, h: 24, radius: 0 }, kde: { w: 40, h: 22, radius: 0 },
              defaults: { fill: "none", stroke: "none", strokeWidth: 0, grow: 1, sizeModeX: "fill", sizeModeY: "hug" } },
  tabs:     { label: "Tabs",      cat: "Navigation", gtk4: { w: 260, h: 34, radius: 8 }, kde: { w: 250, h: 30, radius: 3 },
              defaults: { count: 3, active: 0, text: "Tab", fill: "#f1f3f5", stroke: "#c9ced6", strokeWidth: 1, textColor: "#111827" } },
  wincontrols:{ label: "Window buttons", cat: "Navigation", gtk4: { w: 92, h: 28, radius: 0 }, kde: { w: 96, h: 26, radius: 0 },
              defaults: { fill: "none", stroke: "none", strokeWidth: 0, textColor: "#59636e", controls: "min,max,close" } },
  titlebar: { label: "Title bar", cat: "Navigation", gtk4: { w: 360, h: 44, radius: 0 }, kde: { w: 360, h: 32, radius: 0 },
              defaults: { text: "", fill: "#f6f5f4", stroke: "#c9ced6", strokeWidth: 1, textColor: "#111827", layout: "horizontal", align: "left", gap: 6, padding: { t: 4, r: 8, b: 4, l: 8 } } },
  statusbar:{ label: "Status bar", cat: "Navigation", gtk4: { w: 360, h: 26, radius: 0 }, kde: { w: 360, h: 24, radius: 0 },
              defaults: { text: "Ready", fill: "#f1f3f5", stroke: "#c9ced6", strokeWidth: 1, textColor: "#59636e" } },
  breadcrumb:{ label: "Path bar", cat: "Navigation", gtk4: { w: 300, h: 34, radius: 8 }, kde: { w: 300, h: 30, radius: 3 },
              defaults: { text: "Home / Documents / Project", fill: "#ffffff", stroke: "#c9ced6", strokeWidth: 1, textColor: "#111827" } },
  searchfield:{ label: "Search field", cat: "Navigation", gtk4: { w: 220, h: 34, radius: 8 }, kde: { w: 220, h: 30, radius: 3 },
              defaults: { text: "Search…", fill: "#ffffff", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#6b7280" } },
  splitpane:{ label: "Split pane", cat: "Sections", gtk4: { w: 360, h: 220, radius: 8 }, kde: { w: 360, h: 220, radius: 3 },
              defaults: { fill: "#ffffff", stroke: "#9aa1ac", strokeWidth: 1, value: 50, orientation: "horizontal", layout: "horizontal", align: "left", gap: 8, padding: 8 } },
  // ----- Output -----
  label:    { label: "Label",    cat: "Output", gtk4: { w: 100, h: 20, radius: 0 }, kde: { w: 100, h: 18, radius: 0 },
              defaults: { text: "Label", fill: "none", stroke: "#000000", strokeWidth: 0, textColor: "#111827", alignH: "left" } },
  image:    { label: "Image",    cat: "Output", gtk4: { w: 160, h: 120, radius: 8 }, kde: { w: 160, h: 120, radius: 3 },
              defaults: { fill: "#eef1f5", stroke: "#c9ced6", strokeWidth: 1, textColor: "#9aa1ac" } },
  progress: { label: "Progress", cat: "Output", gtk4: { w: 200, h: 8, radius: 4 }, kde: { w: 200, h: 6, radius: 3 },
              defaults: { value: 60, fill: "#4a9eff", stroke: "#c9ced6", strokeWidth: 0 } },
  list:     { label: "List",     cat: "Output", gtk4: { w: 220, h: 160, radius: 8 }, kde: { w: 220, h: 160, radius: 3 },
              defaults: { fill: "#ffffff", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#111827", count: 4, text: "Item" } },
  clock:    { label: "Clock",    cat: "Output", gtk4: { w: 110, h: 42, radius: 8 }, kde: { w: 100, h: 36, radius: 4 },
              defaults: { text: "10:24", fill: "#ffffff", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#111827", fontSize: 18 } },
  calendar: { label: "Calendar", cat: "Output", gtk4: { w: 260, h: 220, radius: 10 }, kde: { w: 250, h: 210, radius: 4 },
              defaults: { text: "July 2026", fill: "#ffffff", headerFill: "#4a9eff", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#111827" } },
  // ----- Backend (non-visual / logical) -----
  file:     { label: "File",     cat: "Backend", gtk4: { w: 160, h: 30, radius: 6 }, kde: { w: 160, h: 28, radius: 3 },
              defaults: { text: "file.txt", fill: "#f4ede0", stroke: "#c9b48c", strokeWidth: 1, textColor: "#7a5c1e" } },
  storage:  { label: "Storage",  cat: "Backend", gtk4: { w: 160, h: 30, radius: 6 }, kde: { w: 160, h: 28, radius: 3 },
              defaults: { text: "localStorage", fill: "#e6efe6", stroke: "#8cbf8c", strokeWidth: 1, textColor: "#2e6b2e" } },
};

// Cache of loaded SVG/icon images, keyed by src; re-renders when one loads.
const iconCache = {};
function getIconImage(src) {
  if (iconCache[src]) return iconCache[src];
  const img = new Image();
  img.onload = () => render();
  img.onerror = () => { img._failed = true; render(); };
  img.src = "/assets/" + src.split("/").map(encodeURIComponent).join("/");
  iconCache[src] = img;
  return img;
}

// Load the selected shape's name/label/color into the toolbar inputs.
function syncInputsFromSelection() {
  const s = state.shapes[state.selected];
  if (!s) return;
  document.getElementById("areaName").value = s.name || "";
  if (isElement(s)) {
    document.getElementById("areaLabel").value = s.text || "";        // label field = visible text
    document.getElementById("areaColor").value = s.stroke || "#2f7de0";
    document.getElementById("fillColor").value = s.fill || "#4a9eff";
    document.getElementById("radius").value = s.radius || 0;
  } else {
    document.getElementById("areaLabel").value = s.label || "";
    document.getElementById("areaColor").value = s.color || "#ff3b30";
  }
}

// Push the toolbar inputs onto the selected shape (called on input change).
function applyInputsToSelection() {
  if (state.selected === null) return;
  const s = state.shapes[state.selected];
  if (!s) return;
  const name = document.getElementById("areaName").value.trim();
  if (isElement(s)) {
    s.name = name;
    s.text = document.getElementById("areaLabel").value; // keep spaces in labels
    s.stroke = document.getElementById("areaColor").value;
    s.fill = document.getElementById("fillColor").value;
    s.radius = Number(document.getElementById("radius").value) || 0;
  } else {
    if (s.type === "area") s.name = name;
    s.label = document.getElementById("areaLabel").value.trim();
    s.color = document.getElementById("areaColor").value;
  }
  render();
}

const isWindow = (s) => s && s.type === "widget" && s.widget === "window";

function deleteSelected() {
  if (!state.selection.length) return;
  // Keep the sole root Window; delete everything else in the selection.
  const windowsTotal = state.shapes.filter(isWindow).length;
  let blockedWindow = false;
  const toDelete = new Set();
  let windowsMarked = 0;
  for (const i of state.selection) {
    const s = state.shapes[i];
    if (isWindow(s) && windowsTotal - windowsMarked <= 1) { blockedWindow = true; continue; }
    toDelete.add(i);
    if (isWindow(s)) windowsMarked++;
    if (isContainer(s)) for (const k of descendantsOf(s)) toDelete.add(state.shapes.indexOf(k));
  }
  if (!toDelete.size) { if (blockedWindow) toast("The root Window can't be deleted", true); return; }
  // Splice from the end so indices stay valid.
  [...toDelete].sort((a, b) => b - a).forEach(i => state.shapes.splice(i, 1));
  // Children of a deleted container fall back to geometric parenting.
  for (const s of state.shapes) if (s.parent && !byId(s.parent)) { s.parent = null; s.slot = null; }
  clearSelection();
  closeProps();
  relayout();
  if (blockedWindow) toast("Kept the root Window", false);
  render();
}

// ----- Clipboard: copy / cut / paste / duplicate ------------------------
let clipboard = null;
let clipboardRoots = [];
function copySelected() {
  if (!state.selection.length) return;
  const roots = state.selection.map(i => state.shapes[i]).filter(Boolean);
  const copied = new Set(roots);
  for (const s of roots) if (isContainer(s)) for (const k of descendantsOf(s)) copied.add(k);
  clipboardRoots = roots.map(s => s.id);
  clipboard = [...copied].map(s => JSON.parse(JSON.stringify(s)));
}
function cutSelected() {
  if (!state.selection.length) return;
  copySelected();
  deleteSelected();
}
function pasteClipboard() {
  if (!clipboard || !clipboard.length) return;
  const newIdx = [], idMap = new Map();
  for (const item of clipboard) if (item.id) idMap.set(item.id, nextId());
  const clones = clipboard.map(item => {
    const c = JSON.parse(JSON.stringify(item));
    if (c.type === "area") c.pts.forEach(p => { p.x += 16; p.y += 16; });
    else { c.x = (c.x || 0) + 16; c.y = (c.y || 0) + 16; }
    if (c.name) c.name = uniqueName(c.name);
    c.z = nextZ();
    const oldId = c.id;
    if (oldId) c.id = idMap.get(oldId);
    if (c.parent && idMap.has(c.parent)) c.parent = idMap.get(c.parent);
    state.shapes.push(c);
    if (clipboardRoots.includes(oldId)) newIdx.push(state.shapes.length - 1);
    return { c, oldId };
  });
  // Only roots are re-adopted. Descendants retain their remapped hierarchy.
  for (const { c, oldId } of clones) if (clipboardRoots.includes(oldId)) adoptShape(c);
  state.selection = newIdx;
  state.selected = newIdx[newIdx.length - 1];
  syncInputsFromSelection();
  syncPropsToSelection();
  relayout();
  render();
}
function duplicateSelected() { copySelected(); pasteClipboard(); }

// ----- Style clipboard: copy an element's look, apply it to others -------
const STYLE_KEYS = ["fill", "filled", "stroke", "strokeWidth", "strokeOpacity", "radius",
  "opacity", "fontSize", "textColor", "alignH", "alignV", "textOverflow", "showCaption", "margin", "padding", "gap",
  "sizeModeX", "sizeModeY", "widthPercent", "heightPercent", "grow",
  "minW", "maxW", "minH", "maxH", "colSpan", "rowSpan", "hideBelow", "showBelow",
  "wrap", "cols", "align", "justify", "overflow"];
let styleClipboard = null;
function copyStyle() {
  const s = state.selected !== null ? state.shapes[state.selected] : null;
  if (!isElement(s)) { toast("Select an element to copy its style", true); return; }
  styleClipboard = {};
  for (const k of STYLE_KEYS) if (s[k] !== undefined) styleClipboard[k] = JSON.parse(JSON.stringify(s[k]));
  // Snapshot effective defaults too, so Apply reproduces the look exactly.
  styleClipboard.margin = side4(s.margin);
  styleClipboard.padding = side4(s.padding);
  styleClipboard.strokeOpacity = s.strokeOpacity != null ? s.strokeOpacity : 100;
  styleClipboard.opacity = s.opacity != null ? s.opacity : 100;
  toast(`Style copied from ${s.name || s.type}`);
}
function pasteStyle() {
  if (!styleClipboard) { toast("Copy a style first (🖌 Style)", true); return; }
  let n = 0;
  for (const i of state.selection) {
    const s = state.shapes[i];
    if (!isElement(s)) continue;
    Object.assign(s, JSON.parse(JSON.stringify(styleClipboard)));
    n++;
  }
  if (!n) { toast("Select element(s) to apply the style to", true); return; }
  relayout();
  if (state.propOpen !== null) syncPropPanel();
  render();
  toast(`Style applied to ${n} element(s)`);
}

// ----- Toolkit defaults reapplication -------------------------------------
// Reapply the documented toolkit metrics (sizes, radius, padding, gap) and the
// registry's visual style to a widget subtree, without touching semantic text,
// names, or state (checked/on/value/count/active/icon/controls stay as-is).
const DEFAULT_STYLE_KEYS = ["fill", "stroke", "strokeWidth", "textColor", "barFill", "headerFill", "thumbFill"];
function applyToolkitDefaults(root, toolkit) {
  const applyOne = (s) => {
    if (s.type !== "widget" || !WIDGETS[s.widget]) return 0;
    const reg = WIDGETS[s.widget];
    const size = reg[toolkit] || {};
    // Sizes only on fixed axes (fill/hug/percent are layout-driven), and never
    // on Windows — their dimensions are design data, not a toolkit metric.
    if (!isWindow(s)) {
      if ((s.sizeModeX || "fixed") === "fixed" && size.w) s.w = size.w;
      if ((s.sizeModeY || "fixed") === "fixed" && size.h) s.h = size.h;
    }
    if (size.radius != null) s.radius = size.radius;
    const d = reg.defaults || {};
    if (size.padding != null) s.padding = side4(size.padding);
    else if (d.padding != null) s.padding = side4(d.padding);
    if (d.gap != null) s.gap = d.gap;
    for (const k of DEFAULT_STYLE_KEYS) if (d[k] !== undefined) s[k] = d[k];
    s.toolkit = toolkit;
    return 1;
  };
  let n = applyOne(root);
  if (isContainer(root)) for (const k of descendantsOf(root)) n += applyOne(k);
  return n;
}

// ----- Elements tree (sidebar) --------------------------------------------
// Full hierarchy, visible even when a wrong z hides an element on canvas.
// Click selects; drag re-parents / reorders (and lifts above the drop
// target); ▲ brings to front.
function refreshTree() {
  const host = document.getElementById("treeHost");
  if (!host || state.docMode !== "canvas") return;
  const rows = [];
  const walk = (c, d) => {
    for (const k of childrenOf(c).sort((a, b) => slotOf(a) - slotOf(b))) {
      rows.push({ s: k, depth: d });
      if (isContainer(k)) walk(k, d + 1);
    }
  };
  for (const w of state.shapes.filter(isWindow)) { rows.push({ s: w, depth: 0 }); walk(w, 1); }
  const listed = new Set(rows.map(r => r.s));
  for (const s of state.shapes) if (isElement(s) && !listed.has(s)) rows.push({ s, depth: 0, free: true });

  host.innerHTML = "";
  for (const { s, depth, free } of rows) {
    const idx = state.shapes.indexOf(s);
    const row = document.createElement("div");
    row.className = "tree-row" + (state.selection.includes(idx) ? " active" : "") +
      (s.id === state.editComposite ? " editing" : "");
    row.style.paddingLeft = (8 + depth * 14) + "px";
    row.draggable = !isWindow(s);
    const label = `${isContainer(s) ? "▸ " : ""}${s.name || s.id}${free ? " (free)" : ""}${s.fixed ? " 📌" : ""}`;
    row.innerHTML = `<span class="tree-name">${label}</span>` +
      `<span class="tree-meta">${s.widget || s.type} z${zOf(s)}</span>` +
      `<button class="tree-front" title="Bring to front">▲</button>`;
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("tree-front")) return;
      // Choosing a descendant in the out-of-band tree explicitly enters its
      // nearest composite, even when normal canvas clicks select the wrapper.
      for (let p = s.parent ? byId(s.parent) : null; p; p = p.parent ? byId(p.parent) : null)
        if (isComposite(p)) { state.editComposite = p.id; break; }
      if (e.shiftKey) toggleInSelection(idx);
      else selectOnly(idx);
      render();
    });
    row.querySelector(".tree-front").addEventListener("click", () => {
      selectOnly(idx);
      bringFront();
      refreshTree();
    });
    row.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", s.id));
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("dragover"); });
    row.addEventListener("dragleave", () => row.classList.remove("dragover"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("dragover");
      const src = byId(e.dataTransfer.getData("text/plain"));
      if (!src || src === s || isWindow(src)) return;
      // No cycles: don't drop a container into its own subtree.
      for (let p = s; p; p = p.parent ? byId(p.parent) : null) if (p === src) return;
      if (isContainer(s)) { src.parent = s.id; src.slot = 9999; }        // into the container, last slot
      else { src.parent = s.parent || null; src.slot = slotOf(s) === Infinity ? 9999 : slotOf(s) - 0.5; } // before this sibling
      src.z = zOf(s) + 0.5; // lift above the drop target so it's visible
      relayout();
      render();
    });
    host.appendChild(row);
  }
}

// ----- Command line (Phase 5a) -------------------------------------------
// One grammar for the GUI command bar, the terminal, and Claude. Every
// command is a small numeric operation; the log keeps them replayable.
const cmdLog = [];

// Resolve an element by id, exact name, or name prefix (case-insensitive).
function findShape(ref) {
  if (!ref) return null;
  const low = String(ref).toLowerCase();
  return state.shapes.find(s => s.id === ref) ||
         state.shapes.find(s => (s.name || "").toLowerCase() === low) ||
         state.shapes.find(s => (s.name || "").toLowerCase().startsWith(low)) || null;
}

const parseVal = (v) => {
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return !Number.isNaN(n) && String(v).trim() !== "" ? n : v;
};
const tokenize = (str) => (str.match(/"[^"]*"|\S+/g) || []).map(t => t.replace(/^"|"$/g, ""));

const SET_ENUMS = {
  layout: ["none", "vertical", "horizontal", "table"], align: ["start", "center", "end", "stretch"],
  justify: ["start", "center", "end", "space-between", "space-around", "space-evenly"],
  sizeModeX: ["fixed", "fill", "percent", "hug"], sizeModeY: ["fixed", "fill", "percent", "hug"],
  overflow: ["visible", "clip", "scroll"], textOverflow: ["wrap", "ellipsis", "clip"],
  alignH: ["left", "center", "right"], alignV: ["top", "middle", "bottom"],
  toolkit: ["gtk4", "kde"], buttonSide: ["left", "right"], orientation: ["horizontal", "vertical"],
  resizeMode: ["reflow", "scale"], iconPosition: ["left", "right", "top", "bottom", "only"],
  strokeStyle: ["solid", "dashed"], captionMode: ["block", "border"],
  captionSide: ["top", "bottom"], captionAlign: ["left", "center", "right"],
  action: ["none", "toggle", "show", "hide", "switch"],
};
const SET_BOOLEANS = new Set(["fixed", "filled", "wrap", "checked", "on", "bindScroll", "showCaption", "interactionEnabled", "bold", "italic", "borderSides", "shadow", "showText"]);
const SET_STRINGS = new Set(["name", "text", "fill", "stroke", "textColor", "icon", "controls", "barFill", "toggleTarget", "interactionControl", "fontFamily", "target", "src"]);
const SET_NUMBERS = {
  x: [-Infinity, Infinity], y: [-Infinity, Infinity], w: [1, Infinity], h: [1, Infinity], z: [-Infinity, Infinity],
  opacity: [0, 100], strokeWidth: [0, Infinity], strokeOpacity: [0, 100], radius: [0, Infinity],
  fontSize: [6, 96], gap: [0, Infinity], cols: [1, Infinity, true], scrollX: [0, Infinity], scrollY: [0, Infinity],
  value: [0, 100], count: [0, 50, true], active: [0, Infinity, true], lines: [1, 2, true],
  iconSize: [8, 128], iconGap: [0, Infinity], grow: [0, Infinity], minW: [0, Infinity], maxW: [0, Infinity],
  minH: [0, Infinity], maxH: [0, Infinity], widthPercent: [0, 100], heightPercent: [0, 100],
  colSpan: [1, Infinity, true], rowSpan: [1, Infinity, true], slot: [0, Infinity],
  hideBelow: [0, Infinity], showBelow: [0, Infinity],
};

function validatedSet(path, raw) {
  const [prop, side] = path;
  if (path.length > 2) return { error: "set paths support one optional side only" };
  if (["__proto__", "prototype", "constructor"].includes(prop) || ["__proto__", "prototype", "constructor"].includes(side))
    return { error: "unsafe property name" };
  if (side != null) {
    if (!["margin", "padding", "borderSides"].includes(prop)) return { error: `nested property is only valid for margin, padding or borderSides` };
    if (!["t", "r", "b", "l"].includes(side)) return { error: `unknown side "${side}" — use t, r, b or l` };
    if (prop === "borderSides")
      return typeof raw === "boolean" ? { value: raw } : { error: `borderSides.${side} must be true or false` };
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? { value: n } : { error: `${prop}.${side} must be a number ≥ 0` };
  }
  if (prop === "align") {
    const value = normalizeAlign(String(raw));
    if (!["left", "right", ...SET_ENUMS.align].includes(String(raw))) return { error: `align must be ${SET_ENUMS.align.join(", ")}` };
    return { value };
  }
  if (SET_ENUMS[prop]) {
    const value = String(raw);
    return SET_ENUMS[prop].includes(value) ? { value } : { error: `${prop} must be ${SET_ENUMS[prop].join(", ")}` };
  }
  if (SET_BOOLEANS.has(prop)) return typeof raw === "boolean" ? { value: raw } : { error: `${prop} must be true or false` };
  if (SET_STRINGS.has(prop)) return { value: String(raw) };
  if (SET_NUMBERS[prop]) {
    const n = Number(raw), [min, max, integer] = SET_NUMBERS[prop];
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
      return { error: `${prop} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}` };
    return { value: n };
  }
  if (prop === "margin" || prop === "padding") {
    const n = Number(raw); return Number.isFinite(n) && n >= 0 ? { value: side4(n) } : { error: `${prop} must be a number ≥ 0 or use ${prop}.t/r/b/l` };
  }
  return { error: `unknown set property "${prop}"` };
}

const CMD_HELP =
  'new canvas <w> <h> · ' +
  'add <widget|rect|ellipse> [into <container>] [with <prop> <value> …] · ' +
  'add window empty [gtk4|kde] [w] [h] [name] · ' +
  'add window copy <source> [w] [h] [name] · set <el> <prop>[.<side>] <value> · ' +
  'move <el> <dx> <dy> · move <el> into <container> [<slot>] · resize <el> <w> <h> · ' +
  'del <el> · copy <el> [n] · cut <el> · paste · rename <el> <name> · ' +
  'select <el> [<el> …] · select add <el> · select none · arrange <container> · ' +
  'group [name] · make-widget [name] · enter <composite> · exit · ungroup <composite|section> · ' +
  'front <el> · back <el> · style copy <el> · style apply [<el> …] · ' +
  'defaults <el> [gtk4|kde] · theme <GTK light|GTK dark|KDE light|KDE dark> · ' +
  'assets [filter] · tree [root] [all] · inspect <el> · selection · ui <hide|show|toggle> · list · help';

function runCommand(input) {
  const res = execCommand(input);
  cmdLog.push({ cmd: input, ok: res.ok, msg: res.msg });
  return res;
}

let commandFocusNumbers = null;
function setCommandFocus(hidden) {
  const numbers = document.getElementById("showNumbers");
  if (hidden && !document.body.classList.contains("command-focus")) {
    commandFocusNumbers = state.showNumbers;
    numbers.checked = false;
    state.showNumbers = false;
  } else if (!hidden && document.body.classList.contains("command-focus") && commandFocusNumbers !== null) {
    numbers.checked = commandFocusNumbers;
    state.showNumbers = commandFocusNumbers;
    commandFocusNumbers = null;
  }
  document.body.classList.toggle("command-focus", hidden);
  resizeCanvas(); fitToView(); render();
}

function commandShapeLine(s, depth = 0) {
  const index = state.shapes.indexOf(s);
  const selected = state.selection.includes(index);
  const frame = isComposite(s) ? (s.frame || {}) : s;
  const flags = [
    responsiveVisible(s) ? "visible" : "hidden",
    s.fixed ? "fixed" : "managed",
  ];
  const color = frame.fill && frame.fill !== "none" ? frame.fill : "none";
  return {
    selected,
    text: `${selected ? "▶" : " "} ${"  ".repeat(depth)}${s.name || s.id} ` +
      `[${s.widget || s.type}] id=${s.id || "—"} slot=${s.slot ?? "—"} ` +
      `x=${Math.round(s.x || 0)} y=${Math.round(s.y || 0)} ` +
      `w=${Math.round(s.w || 0)} h=${Math.round(s.h || 0)} ` +
      `fill=${color} stroke=${frame.stroke || "none"} ${flags.join(" ")}`,
  };
}

function commandTree(rootRef = "", includeHidden = false) {
  const roots = rootRef ? [findShape(rootRef)].filter(Boolean) : state.shapes.filter(isWindow);
  if (!roots.length) return { error: `no root "${rootRef}"` };
  const lines = [];
  const walk = (s, depth) => {
    if (includeHidden || responsiveVisible(s)) lines.push(commandShapeLine(s, depth));
    if (isContainer(s)) for (const child of childrenOf(s).sort((a, b) => slotOf(a) - slotOf(b))) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return { lines, text: lines.map(line => line.text).join("\n") || "empty design" };
}

function execCommand(input) {
  const t = tokenize(input);
  if (!t.length) return { ok: false, msg: "empty command" };
  const verb = t[0].toLowerCase();
  const done = (msg, data) => {
    relayout();
    if (state.propOpen !== null) syncPropPanel();
    render();
    return data ? { ok: true, msg, data } : { ok: true, msg };
  };
  const fail = (msg) => ({ ok: false, msg });
  try {
    // Remote commands can arrive before any design exists; everything except
    // `new` and `help` needs an open canvas.
    if (verb !== "new" && verb !== "help" && !(state.ready && state.docMode === "canvas"))
      return fail("no active design canvas — run: new canvas <w> <h>");
    switch (verb) {
      case "help":
        return { ok: true, msg: CMD_HELP };

      case "new": {
        if ((t[1] || "").toLowerCase() !== "canvas") return fail("new canvas <w> <h>");
        const w = Math.max(100, Number(t[2]) || 1400), h = Math.max(100, Number(t[3]) || 900);
        hideStart();
        newCanvas(w, h);
        return { ok: true, msg: `new canvas ${w}×${h}` };
      }

      case "ui": {
        const mode = (t[1] || "toggle").toLowerCase();
        if (!["hide", "show", "toggle"].includes(mode)) return fail("ui <hide|show|toggle>");
        const hidden = mode === "toggle" ? !document.body.classList.contains("command-focus") : mode === "hide";
        setCommandFocus(hidden);
        return { ok: true, msg: `editor UI ${hidden ? "hidden" : "shown"}` };
      }

      case "inspect": {
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1] || ""}"`);
        const data = { ...s, visibleNow: responsiveVisible(s), selected: state.selection.includes(state.shapes.indexOf(s)),
          children: isContainer(s) ? childrenOf(s).sort((a, b) => slotOf(a) - slotOf(b)).map(k => k.name || k.id) : [] };
        return { ok: true, msg: JSON.stringify(data, null, 2), data: { kind: "inspect", value: data } };
      }

      case "selection": {
        const lines = state.selection.map(i => state.shapes[i]).filter(Boolean).map(s => commandShapeLine(s));
        return { ok: true, msg: lines.map(line => line.text).join("\n") || "no selection",
          data: { kind: "selection", lines } };
      }

      case "add": {
        const kind = (t[1] || "").toLowerCase();
        if (!kind) return fail("add what? try: add button");
        if (kind === "window") {
          const mode = (t[2] || "empty").toLowerCase();
          if (mode === "empty") {
            const toolkit = ["gtk4", "kde"].includes((t[3] || "").toLowerCase()) ? t[3].toLowerCase() : libToolkit;
            const offset = toolkit === (t[3] || "").toLowerCase() ? 4 : 3;
            const w = Number(t[offset]) || 600, h = Number(t[offset + 1]) || 400;
            const name = t.slice(offset + 2).join(" ") || (toolkit === "kde" ? "KDE Window" : "GTK Window");
            const win = insertWindowPreset(toolkit, { w, h, name, variantLabel: name });
            return win ? done(`added empty window ${win.name} (${win.w}×${win.h})`) : fail("could not add window");
          }
          if (mode === "copy") {
            const source = findShape(t[3]);
            if (!isWindow(source)) return fail(`no window "${t[3] || ""}"`);
            const w = Number(t[4]) || source.w, h = Number(t[5]) || source.h;
            const name = t.slice(6).join(" ") || `${source.name || "Window"} variant`;
            const win = cloneWindowVariant(source, { w, h, name, variantLabel: name });
            return win ? done(`added window variant ${win.name} (${win.w}×${win.h})`) : fail("could not copy window");
          }
          return fail("add window empty [gtk4|kde] [w] [h] [name] | add window copy <source> [w] [h] [name]");
        }
        // add <kind> [x y w h] [into <container>] [with <prop> <value> …]
        const withIdx = t.indexOf("with");
        const head = withIdx > 0 ? t.slice(0, withIdx) : t;
        const propTokens = withIdx > 0 ? t.slice(withIdx + 1) : [];
        if (propTokens.length % 2) return fail("with expects <prop> <value> pairs — quote values containing spaces");
        const intoIdx = head.indexOf("into");
        const container = intoIdx > 0 ? findShape(head[intoIdx + 1]) : null;
        if (intoIdx > 0 && !container) return fail(`no container "${head[intoIdx + 1]}"`);
        // Validate all pairs before creating anything, so a bad pair adds nothing.
        const pairs = [];
        for (let i = 0; i < propTokens.length; i += 2) {
          const prop = propTokens[i], rawVal = propTokens[i + 1];
          if (prop === "name" || prop === "slot") { pairs.push([prop, rawVal]); continue; }
          const checked = validatedSet(prop.split("."), parseVal(rawVal));
          if (checked.error) return fail(checked.error);
          pairs.push([prop, checked.value]);
        }
        let el;
        if (kind === "rect" || kind === "ellipse") {
          const nums = head.slice(2, intoIdx > 0 ? intoIdx : undefined).map(Number);
          const [x = 100, y = 100, w = 160, h = 60] = nums;
          el = { id: nextId(), parent: null, type: kind, x, y, w, h,
            name: nextName(kind), text: "", filled: true, fixed: false, z: nextZ(),
            fontSize: 14, alignH: "center", alignV: "middle", textColor: "#ffffff",
            ...styleFromToolbar() };
          state.shapes.push(el);
          adoptShape(el);
        } else if (WIDGETS[kind]) {
          if (container && isContainer(container)) {
            // Create directly in the target container: the insertWidget path
            // adopts at the canvas centre first, and that transient layout
            // pass can permanently stretch the new widget's geometry.
            el = addPresetChild(kind, libToolkit, container, 9999);
          } else {
            insertWidget(kind, libToolkit);
            el = state.shapes[state.shapes.length - 1];
          }
        } else {
          return fail(`unknown element "${kind}" — rect, ellipse, ${Object.keys(WIDGETS).join(", ")}`);
        }
        if (container && isContainer(container) && !isWindow(el)) { el.parent = container.id; el.slot = 9999; }
        for (const [prop, val] of pairs) {
          if (prop === "name") { el.name = uniqueName(String(val)); continue; }
          if (prop === "slot") { el.slot = Number(val) - 0.5; continue; }
          const path = prop.split(".");
          if (path.length === 2) {
            const next = path[0] === "borderSides" ? borderSides4(el) : side4(el[path[0]]);
            next[path[1]] = val; el[path[0]] = next;
          } else el[prop] = val;
        }
        selectOnly(state.shapes.indexOf(el));
        return done(`added ${el.name}${container ? " into " + (container.name || container.id) : ""}`,
          { kind: "add", id: el.id, name: el.name });
      }

      case "set": {
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1]}"`);
        const path = (t[2] || "").split(".");
        if (!path[0] || t[3] === undefined) return fail("set <el> <prop> <value>");
        const raw = parseVal(t.slice(3).join(" "));
        const checked = validatedSet(path, raw);
        if (checked.error) return fail(checked.error);
        const val = checked.value;
        if (path.length === 2) {
          const next = path[0] === "borderSides" ? borderSides4(s) : side4(s[path[0]]);
          next[path[1]] = val;
          s[path[0]] = next;
        } else {
          s[path[0]] = val;
        }
        return done(`${s.name || s.id}.${t[2]} = ${val}`);
      }

      case "move": {
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1]}"`);
        if ((t[2] || "").toLowerCase() === "into") {
          const c = findShape(t[3]);
          if (!c || !isContainer(c)) return fail(`no container "${t[3]}"`);
          if (isWindow(s)) return fail("windows can't be nested");
          s.parent = c.id;
          // slot N (0-based): N-0.5 sorts between N-1 and N; arrange renumbers.
          s.slot = t[4] != null ? Number(t[4]) - 0.5 : 9999;
          return done(`${s.name} → ${c.name || c.id}${t[4] != null ? " slot " + t[4] : ""}`);
        }
        if (isWindow(s)) return fail("windows are stacked automatically");
        translateSubtree(s, Number(t[2]) || 0, Number(t[3]) || 0);
        adoptShape(s);
        return done(`${s.name} moved`);
      }

      case "resize": {
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1]}"`);
        const nw = Math.max(1, Number(t[2]) || s.w), nh = Math.max(1, Number(t[3]) || s.h);
        if (isComposite(s) && s.resizeMode === "scale" && s.w && s.h) {
          const sx = nw / s.w, sy = nh / s.h;
          for (const k of descendantsOf(s)) {
            k.x = s.x + (k.x - s.x) * sx; k.y = s.y + (k.y - s.y) * sy;
            k.w = Math.max(1, k.w * sx); k.h = Math.max(1, k.h * sy);
          }
        }
        s.w = nw; s.h = nh;
        return done(`${s.name} = ${s.w}×${s.h}`);
      }

      case "make-widget": {
        const c = makeWidgetSelection();
        if (!c) return fail("select at least 3 elements first");
        if (t[1]) c.name = uniqueName(t.slice(1).join(" "));
        return done(`made ${c.name}`);
      }

      case "enter": {
        const c = findShape(t[1]);
        if (!c || !isComposite(c)) return fail(`no composite "${t[1]}"`);
        enterComposite(c);
        return { ok: true, msg: `editing ${c.name}` };
      }

      case "exit": {
        const c = state.editComposite ? byId(state.editComposite) : null;
        if (!c) return fail("not editing a composite");
        exitComposite();
        return { ok: true, msg: `exited ${c.name}` };
      }

      case "ungroup": {
        const c = findShape(t[1]);
        if (!c || !["section", "composite"].includes(c.widget)) return fail(`no group "${t[1]}"`);
        selectOnly(state.shapes.indexOf(c)); ungroupSelection();
        return done(`ungrouped ${c.name}`);
      }

      case "del": case "delete": {
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1]}"`);
        selectOnly(state.shapes.indexOf(s));
        deleteSelected();
        return done(`deleted ${t[1]}`);
      }

      case "copy": {
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1]}"`);
        selectOnly(state.shapes.indexOf(s));
        copySelected();
        const n = Math.max(1, Number(t[2]) || 1);
        for (let i = 0; i < n; i++) pasteClipboard();
        return done(`copied ${t[1]} ×${n}`);
      }

      case "rename": {
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1]}"`);
        if (!t[2]) return fail("rename <el> <new name>");
        s.name = uniqueName(t.slice(2).join(" "));
        return done(`renamed → ${s.name}`);
      }

      case "select": {
        // select none · select add <el> · select <el> [<el> …]
        if ((t[1] || "").toLowerCase() === "none") {
          clearSelection(); render();
          return { ok: true, msg: "selection cleared" };
        }
        const adding = (t[1] || "").toLowerCase() === "add";
        const refs = t.slice(adding ? 2 : 1);
        if (!refs.length) return fail("select <el> [<el> …] | select add <el> | select none");
        let found = refs.map(r => [r, findShape(r)]);
        // Unquoted multi-word name: fall back to all tokens as one reference.
        if (found.some(([, s]) => !s) && findShape(refs.join(" ")))
          found = [[refs.join(" "), findShape(refs.join(" "))]];
        const missing = found.find(([, s]) => !s);
        if (missing) return fail(`no element "${missing[0]}" — quote multi-word names`);
        found.forEach(([, s], i) => {
          const idx = state.shapes.indexOf(s);
          if (!adding && i === 0) selectOnly(idx);
          else if (!state.selection.includes(idx)) toggleInSelection(idx);
        });
        render();
        return { ok: true, msg: `selected ${state.selection.length} element(s)` };
      }

      case "group": {
        if (!state.selection.length) return fail("select element(s) first (select <el> <el> …)");
        const count = state.shapes.length;
        groupSelection();
        if (state.shapes.length === count) return fail("could not group the selection");
        const sec = state.shapes[state.selected];
        if (t[1]) sec.name = uniqueName(t.slice(1).join(" "));
        return done(`grouped into ${sec.name}`);
      }

      case "front": case "back": {
        const ref = t.slice(1).join(" ");
        const s = findShape(ref);
        if (!s) return fail(`no element "${ref}"`);
        selectOnly(state.shapes.indexOf(s));
        if (verb === "front") bringFront(); else sendBack();
        return done(`${s.name || s.id} sent to ${verb}`);
      }

      case "cut": {
        const ref = t.slice(1).join(" ");
        const s = findShape(ref);
        if (!s) return fail(`no element "${ref}"`);
        if (isWindow(s) && state.shapes.filter(isWindow).length <= 1)
          return fail("the root Window can't be cut");
        selectOnly(state.shapes.indexOf(s));
        cutSelected();
        return done(`cut ${s.name || ref}`);
      }

      case "paste": {
        if (!clipboard || !clipboard.length) return fail("clipboard is empty — cut or copy first");
        pasteClipboard();
        const s = state.shapes[state.selected];
        return done(`pasted ${s ? s.name || s.id : "clipboard"}`);
      }

      case "style": {
        const mode = (t[1] || "").toLowerCase();
        if (mode === "copy") {
          const ref = t.slice(2).join(" ");
          const s = findShape(ref);
          if (!s) return fail(`no element "${ref}"`);
          selectOnly(state.shapes.indexOf(s));
          copyStyle();
          return { ok: true, msg: `style copied from ${s.name || s.id}` };
        }
        if (mode === "apply") {
          if (!styleClipboard) return fail("copy a style first (style copy <el>)");
          if (t[2]) {
            let targets = t.slice(2).map(r => [r, findShape(r)]);
            if (targets.some(([, s]) => !s) && findShape(t.slice(2).join(" ")))
              targets = [[t.slice(2).join(" "), findShape(t.slice(2).join(" "))]];
            const missing = targets.find(([, s]) => !s);
            if (missing) return fail(`no element "${missing[0]}" — quote multi-word names`);
            targets.forEach(([, s], i) => {
              const idx = state.shapes.indexOf(s);
              if (i === 0) selectOnly(idx); else if (!state.selection.includes(idx)) toggleInSelection(idx);
            });
          }
          if (!state.selection.length) return fail("select element(s) or name targets: style apply <el> …");
          pasteStyle();
          return done(`style applied to ${state.selection.length} element(s)`);
        }
        return fail("style copy <el> | style apply [<el> …]");
      }

      case "defaults": {
        // Optional toolkit is the last token; the rest is the element reference.
        const last = (t[t.length - 1] || "").toLowerCase();
        const hasToolkit = ["gtk4", "kde"].includes(last) && t.length > 2;
        const ref = t.slice(1, hasToolkit ? -1 : undefined).join(" ");
        const s = findShape(ref);
        if (!s) return fail(`no element "${ref}" — defaults <el> [gtk4|kde]`);
        const toolkit = hasToolkit ? last : s.toolkit || libToolkit;
        const n = applyToolkitDefaults(s, toolkit);
        if (!n) return fail("no toolkit widgets in that subtree");
        return done(`applied ${toolkit} defaults to ${n} widget(s) in ${s.name || s.id}`);
      }

      case "arrange": {
        const c = findShape(t[1]);
        if (!c || !isContainer(c)) return fail(`no container "${t[1]}"`);
        const n = arrangeInto(c);
        render();
        return { ok: true, msg: `arranged ${n} in ${c.name || c.id}` };
      }

      case "theme": {
        const name = t.slice(1).join(" ");
        const key = Object.keys(THEMES).find(k => k.toLowerCase() === name.toLowerCase());
        if (!key) return fail(`themes: ${Object.keys(THEMES).join(" · ")}`);
        document.getElementById("themeSel").value = key;
        renderSwatches();
        applyThemeToDesign();
        return { ok: true, msg: `theme ${key}` };
      }

      case "assets": {
        const filter = t.slice(1).join(" ").toLowerCase();
        if (!libraryIcons.length)
          return fail("asset list not loaded yet — open the editor Library once, then retry");
        const rows = libraryIcons
          .filter(ic => !filter || ic.name.toLowerCase().includes(filter) || ic.src.toLowerCase().includes(filter))
          .map(ic => `${ic.src}${ic.src.startsWith("user/") ? "  (user)" : ""}`);
        return { ok: true, msg: rows.join("\n") || "no assets match",
          data: { kind: "assets", count: rows.length } };
      }

      case "tree": case "list": {
        const args = t.slice(1);
        const includeHidden = args.some(arg => ["all", "--all"].includes(arg.toLowerCase()));
        const rootRef = args.find(arg => !["all", "--all"].includes(arg.toLowerCase())) || "";
        const tree = commandTree(rootRef, includeHidden);
        if (tree.error) return fail(tree.error);
        return { ok: true, msg: tree.text, data: { kind: "tree", lines: tree.lines } };
      }

      default:
        return fail(`unknown command "${verb}" — try help`);
    }
  } catch (err) {
    return fail(err.message);
  }
}

// ----- Theme palettes (GTK Adwaita / KDE Breeze, light & dark) -----------
// Roles are ordered: bg, surface, view, border, text, muted, accent(+hover),
// success, warning, error. Click a swatch → fill; right-click → border.
const THEMES = {
  "GTK light": { dark: false, bg: "#fafafa", surface: "#ffffff", view: "#ffffff", border: "#d5d0cc",
    text: "#3d3846", muted: "#77767b", accent: "#3584e4", accentHi: "#1c71d8",
    success: "#26a269", warning: "#e5a50a", error: "#c01c28" },
  "GTK dark": { dark: true, bg: "#242424", surface: "#303030", view: "#1e1e1e", border: "#1b1b1b",
    text: "#ffffff", muted: "#9a9996", accent: "#78aeed", accentHi: "#62a0ea",
    success: "#33d17a", warning: "#f8e45c", error: "#ff7b63" },
  "KDE light": { dark: false, bg: "#eff0f1", surface: "#fcfcfc", view: "#ffffff", border: "#bdc3c7",
    text: "#232629", muted: "#7f8c8d", accent: "#3daee9", accentHi: "#93cee9",
    success: "#27ae60", warning: "#f67400", error: "#da4453" },
  "KDE dark": { dark: true, bg: "#31363b", surface: "#2a2e32", view: "#232629", border: "#4d4d4d",
    text: "#eff0f1", muted: "#a1a9b1", accent: "#3daee9", accentHi: "#93cee9",
    success: "#27ae60", warning: "#f67400", error: "#da4453" },
};

function currentTheme() { return THEMES[document.getElementById("themeSel").value]; }

function buildPalette() {
  const sel = document.getElementById("themeSel");
  sel.innerHTML = Object.keys(THEMES).map(n => `<option>${n}</option>`).join("");
  sel.addEventListener("change", renderSwatches);
  renderSwatches();
}

function renderSwatches() {
  const t = currentTheme();
  const host = document.getElementById("swatches");
  host.innerHTML = "";
  for (const [role, color] of Object.entries(t)) {
    if (role === "dark") continue;
    const b = document.createElement("div");
    b.className = "swatch";
    b.style.background = color;
    b.title = `${role}: ${color}\nclick → fill · right-click → border`;
    const apply = (prop) => {
      let n = 0;
      for (const i of state.selection) {
        const s = state.shapes[i];
        if (!isElement(s)) continue;
        if (prop === "fill") { s.fill = color; s.filled = true; } else s.stroke = color;
        n++;
      }
      if (!n) { toast("Select element(s) first", true); return; }
      if (state.propOpen !== null) syncPropPanel();
      render();
    };
    b.addEventListener("click", () => apply("fill"));
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); apply("stroke"); });
    host.appendChild(b);
  }
}

// Apply the selected theme's colors to the whole design by widget role.
function applyThemeToDesign() {
  const t = currentTheme();
  for (const s of state.shapes) {
    if (!isElement(s)) continue;
    if (isWindow(s)) { s.fill = t.bg; s.stroke = t.border; s.textColor = t.text; }
    else if (s.widget === "section") { s.stroke = t.border; s.textColor = t.muted; }
    else if (s.widget === "button") { s.fill = t.accent; s.stroke = t.accentHi; s.textColor = t.dark ? "#1e1e1e" : "#ffffff"; }
    else if (s.widget === "textbox" || s.widget === "dropdown" || s.widget === "list") { s.fill = t.view; s.stroke = t.border; s.textColor = t.text; }
    else if (s.widget === "label") { s.textColor = t.text; }
    else if (s.type === "widget") { s.fill = s.fill && s.fill !== "none" ? t.surface : s.fill; s.stroke = t.border; s.textColor = t.text; }
    else { s.stroke = t.border; s.textColor = t.text; } // rect/ellipse keep their fill
  }
  if (state.propOpen !== null) syncPropPanel();
  render();
  toast(`Theme applied: ${document.getElementById("themeSel").value}`);
}

// ----- Group / ungroup --------------------------------------------------
function makeWidgetSelection() {
  let items = state.selection.map(i => state.shapes[i]).filter(s => isElement(s) && !isWindow(s));
  const chosen = new Set(items);
  items = items.filter(s => { for (let p = s.parent ? byId(s.parent) : null; p; p = p.parent ? byId(p.parent) : null) if (chosen.has(p)) return false; return true; });
  if (items.length < 3) { toast("Make Widget needs at least 3 top-level selected elements", true); return null; }
  const xs = items.flatMap(s => [s.x, s.x + s.w]), ys = items.flatMap(s => [s.y, s.y + s.h]);
  const minx = Math.min(...xs), miny = Math.min(...ys), maxx = Math.max(...xs), maxy = Math.max(...ys);
  const sameParent = items.every(s => (s.parent || null) === (items[0].parent || null));
  const composite = {
    type: "widget", widget: "composite", id: nextId(), name: uniqueName("Widget"),
    parent: sameParent ? (items[0].parent || null) : null, slot: sameParent ? Math.min(...items.map(slotOf)) : null,
    x: Math.round(minx), y: Math.round(miny), w: Math.max(1, Math.round(maxx - minx)), h: Math.max(1, Math.round(maxy - miny)),
    layout: "none", align: "left", padding: 0, fixed: false,
    sizeModeX: "fixed", sizeModeY: "fixed", z: Math.min(...items.map(zOf)) - 1,
    frame: { filled: false, fill: "#ffffff", stroke: "#4a9eff", strokeWidth: 1, strokeOpacity: 100,
      radius: 12, radiusTL: 12, radiusTR: 12, radiusBR: 12, radiusBL: 12, cornersLinked: true },
    resizeMode: "reflow",
  };
  state.shapes.push(composite);
  [...items].sort((a, b) => slotOf(a) - slotOf(b) || a.y - b.y || a.x - b.x)
    .forEach((s, i) => { s.parent = composite.id; s.slot = i; });
  state.editComposite = null;
  selectOnly(state.shapes.indexOf(composite));
  relayout(); render();
  toast(`Made ${composite.name} from ${items.length} elements`);
  return composite;
}

function enterComposite(target = null) {
  const s = target || (state.selected !== null ? state.shapes[state.selected] : null);
  if (!isComposite(s)) { toast("Select a composite widget first", true); return false; }
  state.editComposite = s.id;
  const first = childrenOf(s).sort((a, b) => slotOf(a) - slotOf(b))[0];
  if (first) selectOnly(state.shapes.indexOf(first));
  refreshTree(); render(); toast(`Editing ${s.name}`); return true;
}

function exitComposite() {
  const s = state.editComposite ? byId(state.editComposite) : null;
  if (!s) { toast("Not editing a composite", true); return false; }
  state.editComposite = null;
  selectOnly(state.shapes.indexOf(s));
  refreshTree(); render(); toast(`Exited ${s.name}`); return true;
}

function groupSelection() {
  const items = state.selection.map(i => state.shapes[i]).filter(s => isElement(s) && !isWindow(s));
  if (items.length < 1) { toast("Select element(s) to group", true); return; }
  const pad = 12, head = 22;
  const xs = items.flatMap(s => [s.x, s.x + s.w]), ys = items.flatMap(s => [s.y, s.y + s.h]);
  const minx = Math.min(...xs), miny = Math.min(...ys), maxx = Math.max(...xs), maxy = Math.max(...ys);
  const sec = {
    type: "widget", widget: "section", name: uniqueName("Group"),
    x: Math.round(minx - pad), y: Math.round(miny - pad - head),
    w: Math.round(maxx - minx + 2 * pad), h: Math.round(maxy - miny + 2 * pad + head),
    radius: 8, fill: "none", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#6b7280",
    layout: "none", align: "left", padding: pad, fixed: false,
    z: Math.min(...items.map(zOf)) - 1, // behind its children
    id: nextId(), parent: null,
  };
  state.shapes.push(sec);
  adoptShape(sec); // the section itself nests into the window under it
  // The grouped elements become the section's ordered children (top→bottom).
  [...items].sort((a, b) => a.y - b.y || a.x - b.x)
    .forEach((s, i) => { s.parent = sec.id; s.slot = i; });
  selectOnly(state.shapes.length - 1);
  render();
  toast(`Grouped ${items.length} into ${sec.name}`);
}

function ungroupSelection() {
  const secs = state.selection.filter(i => state.shapes[i] && ["section", "composite"].includes(state.shapes[i].widget));
  if (!secs.length) { toast("Select a Section or composite to ungroup", true); return; }
  // Children move up to the removed section's own parent.
  for (const i of secs) {
    const sec = state.shapes[i];
    const base = sec.slot != null ? sec.slot : 9999;
    for (const [n, k] of childrenOf(sec).sort((a, b) => slotOf(a) - slotOf(b)).entries()) {
      k.parent = sec.parent || null; k.slot = base + n / 100;
    }
    if (state.editComposite === sec.id) state.editComposite = null;
  }
  secs.sort((a, b) => b - a).forEach(i => state.shapes.splice(i, 1));
  clearSelection(); closeProps(); relayout(); render();
  toast("Ungrouped");
}

// ----- Ctrl+Click element properties panel ------------------------------
const PP = (id) => document.getElementById("pp" + id);

// With Show text off, the rest of the Text category is inert — grey it out.
// (The element Name lives in its own section and is never affected.)
const TEXT_CONTROL_IDS = ["Text", "Font", "Bold", "Italic", "FontFamily",
  "AlignH", "AlignV", "TextOverflow", "TextColor",
  "ShowCaption", "CaptionMode", "CaptionSide", "CaptionAlign"];
function updateTextControlsDisabled(off) {
  for (const id of TEXT_CONTROL_IDS) {
    const el = PP(id);
    el.disabled = off;
    (el.closest("label") || el).style.opacity = off ? ".45" : "";
  }
}

// Show element `index` in the docked sidebar properties panel.
function openProps(index) {
  const s = state.shapes[index];
  if (!isElement(s)) return; // panel is for design elements
  state.propOpen = index;
  syncPropPanel();
  document.getElementById("propPanel").classList.remove("empty");
}

function closeProps() {
  state.propOpen = null;
  const panel = document.getElementById("propPanel");
  panel.classList.add("empty");
  document.getElementById("ppTitle").textContent = "Properties";
}

// Push the open element's current values into the panel fields.
function syncPropPanel() {
  if (state.propOpen === null) return;
  const s = state.shapes[state.propOpen];
  if (!isElement(s)) { closeProps(); return; }
  PP("Title").textContent = isComposite(s) ? "Composite Widget" : s.type === "widget" ? (WIDGETS[s.widget]?.label || "Widget")
    : s.type === "ellipse" ? "Ellipse" : s.type === "icon" ? "Icon" : "Rectangle";
  PP("Name").value = s.name || "";
  PP("Text").value = s.text || "";
  // Windows are auto-stacked: position is managed, size stays editable.
  PP("X").disabled = PP("Y").disabled = isWindow(s);
  PP("X").value = Math.round(s.x);
  PP("Y").value = Math.round(s.y);
  PP("W").value = Math.round(s.w);
  PP("H").value = Math.round(s.h);
  PP("Fixed").checked = !!s.fixed;
  PP("Z").value = zOf(s);
  // Parent selector: any container except the element itself or its own subtree.
  const inSubtree = (c) => { for (let p = c; p; p = p.parent ? byId(p.parent) : null) if (p === s) return true; return false; };
  const parentRow = PP("Parent").parentElement;
  parentRow.hidden = isWindow(s);
  if (!isWindow(s)) {
    const opts = state.shapes.filter(c => isContainer(c) && !inSubtree(c));
    PP("Parent").innerHTML = '<option value="">(none — free)</option>' +
      opts.map(c => `<option value="${c.id}">${(c.name || c.widget)}</option>`).join("");
    PP("Parent").value = s.parent && opts.some(c => c.id === s.parent) ? s.parent : "";
  }
  const kidsEl = document.getElementById("ppKids");
  kidsEl.hidden = !isContainer(s);
  if (isContainer(s)) kidsEl.textContent = `Children: ${childrenOf(s).length}`;
  const look = isComposite(s) ? (s.frame ||= {}) : s;
  PP("Filled").checked = look.filled !== false && look.fill !== "none";
  PP("Fill").value = /^#[0-9a-f]{6}$/i.test(look.fill || "") ? look.fill : "#4a9eff";
  PP("Stroke").value = look.stroke || "#2f7de0";
  const sw = look.strokeWidth != null ? look.strokeWidth : 1;
  PP("StrokeW").value = sw; PP("StrokeWv").textContent = sw;
  const rad = look.radius || 0;
  PP("Radius").value = rad; PP("Radiusv").textContent = rad;
  const fs = s.fontSize || 14;
  PP("Font").value = fs; PP("Fontv").textContent = fs;
  const op = s.opacity != null ? s.opacity : 100;
  PP("Opacity").value = op; PP("Opacityv").textContent = op;
  const so = look.strokeOpacity != null ? look.strokeOpacity : 100;
  PP("StrokeO").value = so; PP("StrokeOv").textContent = so;
  const M = side4(s.margin), Pd = side4(s.padding);
  PP("MarT").value = M.t; PP("MarR").value = M.r; PP("MarB").value = M.b; PP("MarL").value = M.l;
  PP("PadT").value = Pd.t; PP("PadR").value = Pd.r; PP("PadB").value = Pd.b; PP("PadL").value = Pd.l;
  PP("SizeX").value = s.sizeModeX || "fixed";
  PP("SizeY").value = s.sizeModeY || "fixed";
  PP("PercentW").value = s.widthPercent != null ? s.widthPercent : 100;
  PP("PercentH").value = s.heightPercent != null ? s.heightPercent : 100;
  PP("PercentW").disabled = PP("SizeX").value !== "percent";
  PP("PercentH").disabled = PP("SizeY").value !== "percent";
  PP("Grow").value = s.grow || 0;
  PP("MinW").value = s.minW || 0; PP("MaxW").value = s.maxW || "";
  PP("MinH").value = s.minH || 0; PP("MaxH").value = s.maxH || "";
  PP("ColSpan").value = s.colSpan || 1; PP("RowSpan").value = s.rowSpan || 1;
  PP("HideBelow").value = s.hideBelow || ""; PP("ShowBelow").value = s.showBelow || "";
  const textAlign = defaultTextAlign(s);
  PP("AlignH").value = s.alignH || textAlign.h;
  PP("AlignV").value = s.alignV || textAlign.v;
  PP("TextOverflow").value = s.textOverflow || "wrap";
  const caption = s.type === "widget" && s.widget === "section";
  document.getElementById("ppCaptionRow").hidden = !caption;
  PP("ShowCaption").checked = caption && sectionCaptionVisible(s);
  document.getElementById("ppCaptionOpts").hidden = !(caption && sectionCaptionVisible(s));
  if (caption) {
    PP("CaptionMode").value = s.captionMode || "block";
    PP("CaptionSide").value = s.captionSide || "top";
    PP("CaptionAlign").value = s.captionAlign || "left";
  }
  PP("TextColor").value = s.textColor || "#ffffff";
  PP("ShowText").checked = s.showText !== false;
  updateTextControlsDisabled(s.showText === false);
  PP("Bold").checked = !!s.bold;
  PP("Italic").checked = !!s.italic;
  PP("FontFamily").value = s.fontFamily || "";
  PP("Shadow").checked = !!s.shadow;
  PP("StrokeStyle").value = s.strokeStyle || "solid";
  const perSide = s.type === "widget" && ["section", "window"].includes(s.widget);
  document.getElementById("ppBorderSidesRow").hidden = !perSide;
  if (perSide) {
    const B = borderSides4(s);
    PP("BorderT").checked = B.t; PP("BorderR").checked = B.r;
    PP("BorderB").checked = B.b; PP("BorderL").checked = B.l;
  }
  const composite = isComposite(s);
  document.getElementById("ppCompositeSec").hidden = !composite;
  if (composite) {
    const r = cornerRadii(s);
    PP("CornersLinked").checked = look.cornersLinked !== false;
    PP("RadiusTL").value = r.tl; PP("RadiusTR").value = r.tr;
    PP("RadiusBR").value = r.br; PP("RadiusBL").value = r.bl;
    PP("ResizeMode").value = s.resizeMode || "reflow";
  }
  // SVG assets can be embedded in controls, not only placed as standalone
  // canvas elements. Keep the picker focused on widgets where an icon is a
  // normal toolkit concept.
  const iconCapable = s.type === "widget" && ["button", "toolbutton", "menuitem", "textbox"].includes(s.widget);
  const imageWidget = s.type === "widget" && s.widget === "image";
  document.getElementById("ppIconSec").hidden = !iconCapable && !imageWidget;
  if (iconCapable || imageWidget) {
    refreshWidgetIconOptions();
    PP("Icon").value = (imageWidget ? s.src : s.icon) || "";
    // Placement/size/gap describe icon-in-control layout; an Image widget's
    // asset simply fills its frame, so those rows hide.
    for (const id of ["IconSize", "IconPosition", "IconGap"])
      (PP(id).closest("label") || PP(id)).hidden = imageWidget;
    const iconSize = Math.max(8, Number(s.iconSize) || (s.widget === "menuitem" || s.widget === "textbox" ? 16 : 18));
    PP("IconSize").value = iconSize; PP("IconSizev").textContent = iconSize;
    PP("IconPosition").value = s.iconPosition || (s.widget === "toolbutton" ? "only" : "left");
    PP("IconGap").value = Math.max(0, Number(s.iconGap) || 6);
  }
  const interactionTrigger = s.type === "widget" && ["button", "toolbutton", "menuitem"].includes(s.widget);
  const interactiveScroll = (isContainer(s) && s.overflow === "scroll") || s.widget === "scrollbar";
  const interactionTargetContainer = s.type === "widget" && ["section", "composite"].includes(s.widget) && !interactiveScroll;
  const interactionCapable = interactionTrigger || interactiveScroll || interactionTargetContainer;
  document.getElementById("ppInteractionSec").hidden = !interactionCapable;
  if (interactionCapable) {
    document.getElementById("ppActionRows").hidden = !interactionTrigger;
    if (interactionTrigger) {
      PP("Action").value = s.action || "none";
      PP("ActionTarget").value = s.target || "";
    }
    PP("InteractionEnabled").checked = s.interactionEnabled != null ? !!s.interactionEnabled : interactiveScroll;
    PP("ToggleTarget").value = interactionTargetContainer ? (s.interactionControl || "") : (s.toggleTarget || "");
    const targetRow = document.getElementById("ppToggleTargetRow");
    targetRow.hidden = interactiveScroll && !interactionTrigger;
    targetRow.firstChild.nodeValue = interactionTargetContainer ? "Toggle control " : "Hide/show target ";
    document.getElementById("ppInteractionNote").textContent = interactiveScroll && !interactionTrigger
      ? "When enabled, wheel/range input scrolls this container instead of zooming the canvas."
      : interactionTargetContainer
        ? "Choose the Button or Tool button that will hide/show this element."
        : "The selected control will hide/show its target in the canvas and generated HTML.";
    const options = document.getElementById("ppTargetOptions");
    options.innerHTML = "";
    const seen = new Set();
    for (const candidate of state.shapes.filter(isElement)) {
      const name = candidate.name || candidate.id;
      if (!name || candidate === s || seen.has(name)) continue;
      seen.add(name);
      const option = document.createElement("option"); option.value = name; option.label = candidate.id || "";
      options.appendChild(option);
    }
  }
  // Layout section only applies to containers (Section / Window).
  const container = isContainer(s);
  document.getElementById("ppLayoutSec").hidden = !container;
  if (container) {
    PP("Layout").value = s.layout || "vertical";
    PP("Align").value = normalizeAlign(s.align);
    PP("Justify").value = normalizeJustify(s.justify);
    PP("Gap").value = s.gap != null ? s.gap : 12;
    PP("Cols").value = s.cols || 2;
    PP("Wrap").checked = !!s.wrap;
    PP("Overflow").value = s.overflow || "visible";
    PP("ScrollX").value = s.scrollX || 0; PP("ScrollY").value = s.scrollY || 0;
    document.getElementById("ppScrollRow").hidden = (s.overflow || "visible") !== "scroll";
  }
  // State section for stateful widgets.
  const stateful = s.type === "widget" && ["checkbox", "radio", "toggle", "slider", "scrollbar", "progress", "list", "toolbar", "tabs", "separator", "splitpane"].includes(s.widget);
  document.getElementById("ppStateSec").hidden = !stateful;
  if (stateful) {
    const bool = ["checkbox", "radio", "toggle"].includes(s.widget);
    const val = ["slider", "scrollbar", "progress", "splitpane"].includes(s.widget);
    const isSep = s.widget === "separator";
    const count = ["list", "toolbar", "tabs"].includes(s.widget) || isSep;
    // Reuse the count field for tab-count and separator line-count; relabel it.
    const countRow = document.getElementById("ppStateCountRow");
    countRow.firstChild.nodeValue = isSep ? "Lines " : s.widget === "tabs" ? "Tabs "
      : s.widget === "list" ? "Rows " : "Buttons ";
    PP("StateCount").min = isSep ? 1 : 0;
    PP("StateCount").max = isSep ? 2 : 50;
    document.getElementById("ppStateBoolRow").hidden = !bool;
    document.getElementById("ppStateValRow").hidden = !val;
    document.getElementById("ppStateCountRow").hidden = !count;
    const scrollBar = s.widget === "scrollbar";
    document.getElementById("ppScrollBindRow").hidden = !scrollBar;
    PP("ScrollBind").checked = scrollBar && !!s.bindScroll;
    if (bool) {
      PP("StateBool").checked = s.widget === "toggle" ? !!s.on : !!s.checked;
      document.getElementById("ppStateBoolLbl").textContent = s.widget === "toggle" ? "On" : "Checked";
    } else if (val) {
      const v = s.value != null ? s.value : 0;
      PP("StateVal").value = v; PP("StateValv").textContent = v;
    } else if (count) {
      PP("StateCount").value = isSep ? (s.lines === 2 ? 2 : 1)
        : s.count != null ? s.count : (s.widget === "toolbar" ? 5 : s.widget === "tabs" ? 3 : 4);
    }
  }
}

// Read the panel fields back onto the open element.
function applyPropPanel() {
  if (state.propOpen === null) return;
  const s = state.shapes[state.propOpen];
  if (!isElement(s)) return;
  s.name = PP("Name").value.trim();
  s.text = PP("Text").value;
  s.x = Number(PP("X").value) || 0;
  s.y = Number(PP("Y").value) || 0;
  s.w = Math.max(1, Number(PP("W").value) || 1);
  s.h = Math.max(1, Number(PP("H").value) || 1);
  s.fixed = PP("Fixed").checked;
  s.z = Number(PP("Z").value) || 0;
  if (!isWindow(s)) {
    const npid = PP("Parent").value || null;
    if (npid !== (s.parent || null)) { s.parent = npid; s.slot = 9999; } // append at the end
  }
  const look = isComposite(s) ? (s.frame ||= {}) : s;
  look.filled = PP("Filled").checked;
  look.fill = look.filled ? PP("Fill").value : "none";
  look.stroke = PP("Stroke").value;
  look.strokeWidth = Math.max(0, Number(PP("StrokeW").value) || 0);
  look.strokeOpacity = Math.max(0, Math.min(100, Number(PP("StrokeO").value)));
  look.radius = Math.max(0, Number(PP("Radius").value) || 0);
  if (isComposite(s)) {
    look.cornersLinked = PP("CornersLinked").checked;
    if (look.cornersLinked) {
      look.radiusTL = look.radiusTR = look.radiusBR = look.radiusBL = look.radius;
    } else {
      look.radiusTL = Math.max(0, Number(PP("RadiusTL").value) || 0);
      look.radiusTR = Math.max(0, Number(PP("RadiusTR").value) || 0);
      look.radiusBR = Math.max(0, Number(PP("RadiusBR").value) || 0);
      look.radiusBL = Math.max(0, Number(PP("RadiusBL").value) || 0);
    }
    s.resizeMode = PP("ResizeMode").value || "reflow";
  } else s.radius = look.radius;
  s.fontSize = Math.max(6, Number(PP("Font").value) || 14);
  s.opacity = Math.max(0, Math.min(100, Number(PP("Opacity").value)));
  const n0 = (id) => Math.max(0, Number(PP(id).value) || 0);
  s.margin = { t: n0("MarT"), r: n0("MarR"), b: n0("MarB"), l: n0("MarL") };
  s.padding = { t: n0("PadT"), r: n0("PadR"), b: n0("PadB"), l: n0("PadL") };
  s.sizeModeX = PP("SizeX").value;
  s.sizeModeY = PP("SizeY").value;
  s.widthPercent = Math.max(0, Math.min(100, Number(PP("PercentW").value) || 0));
  s.heightPercent = Math.max(0, Math.min(100, Number(PP("PercentH").value) || 0));
  PP("PercentW").disabled = s.sizeModeX !== "percent";
  PP("PercentH").disabled = s.sizeModeY !== "percent";
  s.grow = Math.max(0, Number(PP("Grow").value) || 0);
  s.minW = n0("MinW"); s.maxW = n0("MaxW");
  s.minH = n0("MinH"); s.maxH = n0("MaxH");
  s.colSpan = Math.max(1, Math.round(Number(PP("ColSpan").value) || 1));
  s.rowSpan = Math.max(1, Math.round(Number(PP("RowSpan").value) || 1));
  s.hideBelow = n0("HideBelow"); s.showBelow = n0("ShowBelow");
  s.alignH = PP("AlignH").value;
  s.alignV = PP("AlignV").value;
  s.textOverflow = PP("TextOverflow").value;
  if (s.type === "widget" && s.widget === "section") {
    s.showCaption = PP("ShowCaption").checked;
    s.captionMode = PP("CaptionMode").value;
    s.captionSide = PP("CaptionSide").value;
    s.captionAlign = PP("CaptionAlign").value;
    document.getElementById("ppCaptionOpts").hidden = !s.showCaption;
  }
  s.textColor = PP("TextColor").value;
  s.showText = PP("ShowText").checked ? undefined : false;
  updateTextControlsDisabled(s.showText === false);
  s.bold = PP("Bold").checked || undefined;
  s.italic = PP("Italic").checked || undefined;
  s.fontFamily = PP("FontFamily").value.trim() || undefined;
  s.shadow = PP("Shadow").checked || undefined;
  s.strokeStyle = PP("StrokeStyle").value === "dashed" ? "dashed" : undefined;
  if (s.type === "widget" && ["section", "window"].includes(s.widget)) {
    const B = { t: PP("BorderT").checked, r: PP("BorderR").checked, b: PP("BorderB").checked, l: PP("BorderL").checked };
    s.borderSides = (B.t && B.r && B.b && B.l) ? undefined : B;
  }
  const interactionTrigger = s.type === "widget" && ["button", "toolbutton", "menuitem"].includes(s.widget);
  const interactiveScroll = (isContainer(s) && PP("Overflow").value === "scroll") || s.widget === "scrollbar";
  const interactionTargetContainer = s.type === "widget" && ["section", "composite"].includes(s.widget) && !interactiveScroll;
  if (interactionTrigger || interactiveScroll || interactionTargetContainer) {
    s.interactionEnabled = PP("InteractionEnabled").checked;
    s.toggleTarget = interactionTrigger ? PP("ToggleTarget").value.trim() : "";
    s.interactionControl = interactionTargetContainer ? PP("ToggleTarget").value.trim() : "";
  }
  if (interactionTrigger) {
    const act = PP("Action").value;
    s.action = act !== "none" ? act : undefined;
    s.target = PP("ActionTarget").value.trim() || undefined;
  }
  if (s.type === "widget" && ["button", "toolbutton", "menuitem", "textbox"].includes(s.widget)
      && PP("Icon").value !== "__pick__") {
    s.icon = PP("Icon").value || null;
    s.iconSize = Math.max(8, Number(PP("IconSize").value) || 18);
    s.iconPosition = PP("IconPosition").value || "left";
    s.iconGap = Math.max(0, Number(PP("IconGap").value) || 0);
    PP("IconSizev").textContent = s.iconSize;
    if (s.icon) getIconImage(s.icon);
  }
  if (s.type === "widget" && s.widget === "image" && PP("Icon").value !== "__pick__") {
    s.src = PP("Icon").value || null;
    if (s.src) getIconImage(s.src);
  }
  if (isContainer(s)) {
    s.layout = PP("Layout").value; s.align = normalizeAlign(PP("Align").value);
    s.justify = normalizeJustify(PP("Justify").value); s.gap = n0("Gap");
    s.cols = Math.max(1, Math.round(Number(PP("Cols").value) || 1)); s.wrap = PP("Wrap").checked;
    s.overflow = PP("Overflow").value;
    s.scrollX = n0("ScrollX"); s.scrollY = n0("ScrollY");
    document.getElementById("ppScrollRow").hidden = s.overflow !== "scroll";
  }
  if (s.type === "widget") {
    if (s.widget === "checkbox" || s.widget === "radio") s.checked = PP("StateBool").checked;
    else if (s.widget === "toggle") s.on = PP("StateBool").checked;
    else if (s.widget === "slider" || s.widget === "scrollbar" || s.widget === "progress") {
      s.value = Number(PP("StateVal").value); PP("StateValv").textContent = s.value;
      if (s.widget === "scrollbar") { s.bindScroll = PP("ScrollBind").checked; if (s.bindScroll) s.fixed = true; }
    }
    else if (["list", "toolbar", "tabs"].includes(s.widget)) s.count = Math.max(0, Math.min(50, Number(PP("StateCount").value) || 0));
    else if (s.widget === "separator") s.lines = Math.max(1, Math.min(2, Number(PP("StateCount").value) || 1));
  }
  // Live value indicators next to the sliders.
  PP("StrokeWv").textContent = look.strokeWidth;
  PP("StrokeOv").textContent = look.strokeOpacity;
  PP("Radiusv").textContent = look.radius;
  PP("Fontv").textContent = s.fontSize;
  PP("Opacityv").textContent = s.opacity;
  if (state.propOpen === state.selected) syncInputsFromSelection();
  relayout(); // size/layout edits restack windows & rearrange managed containers
  render();
}

async function save() {
  if (!state.ready) { toast("Nothing to save — capture or start a canvas first", true); return; }
  // Render at true image resolution without cursor/preview chrome.
  const off = document.createElement("canvas");
  off.width = state.W; off.height = state.H;
  const g = off.getContext("2d");
  const wasBuilding = state.building;
  state.building = null; // don't burn the in-progress polyline
  // Canvas mode draws no document background — give the saved PNG one.
  if (state.docMode === "canvas") { g.fillStyle = state.bgColor; g.fillRect(0, 0, off.width, off.height); }
  drawScene(g, { scale: 1, ox: 0, oy: 0 }, off.width, off.height, { cursor: false });
  state.building = wasBuilding;

  const name = document.getElementById("areaName").value.trim() || "measurement";
  try {
    const res = await fetch("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, dataUrl: off.toDataURL("image/png") }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    toast("Saved → " + data.path);
  } catch (err) {
    toast("Save failed: " + err.message, true);
  }
}

const sizingData = (s) => ({
  sizeModeX: s.sizeModeX || "fixed", sizeModeY: s.sizeModeY || "fixed", grow: s.grow || 0,
  widthPercent: s.widthPercent != null ? s.widthPercent : 100,
  heightPercent: s.heightPercent != null ? s.heightPercent : 100,
  minW: s.minW || 0, maxW: s.maxW || 0, minH: s.minH || 0, maxH: s.maxH || 0,
  colSpan: s.colSpan || 1, rowSpan: s.rowSpan || 1,
  hideBelow: s.hideBelow || 0, showBelow: s.showBelow || 0,
});

// Serialize a single shape into the export format with computed metrics.
function serializeShape(s) {
  if (s.type === "point") {
    return { type: "point", label: s.label || null, color: s.color, x: s.x, y: s.y };
  }
  if (s.type === "icon") {
    return {
      type: "icon", id: s.id || null, parent: s.parent || null, slot: s.slot != null ? s.slot : null,
      name: s.name || null, src: s.src,
      ...sizingData(s),
      x: Math.round(s.x), y: Math.round(s.y),
      w: Math.round(s.w), h: Math.round(s.h),
      fixed: !!s.fixed, z: zOf(s),
      center: { x: Math.round(s.x + s.w / 2), y: Math.round(s.y + s.h / 2) },
    };
  }
  if (s.type === "widget") {
    const out = {
      type: "widget", id: s.id || null, parent: s.parent || null, slot: s.slot != null ? s.slot : null,
      widget: s.widget, toolkit: s.toolkit || null, name: s.name || null,
      ...sizingData(s),
      x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h),
      radius: s.radius || 0, fixed: !!s.fixed, z: zOf(s),
      opacity: s.opacity != null ? s.opacity : 100, margin: s.margin || 0, padding: s.padding || 0,
      fill: s.fill, stroke: s.stroke, strokeWidth: s.strokeWidth,
      text: s.text || null, fontSize: s.fontSize || 14, textColor: s.textColor,
      alignH: s.alignH || null, alignV: s.alignV || null, textOverflow: s.textOverflow || "wrap",
    };
    if (s.variantOf) out.variantOf = s.variantOf;
    if (s.variantLabel) out.variantLabel = s.variantLabel;
    if (s.strokeStyle) out.strokeStyle = s.strokeStyle;
    if (s.borderSides != null) out.borderSides = borderSides4(s);
    if (s.captionMode) out.captionMode = s.captionMode;
    if (s.captionSide) out.captionSide = s.captionSide;
    if (s.captionAlign) out.captionAlign = s.captionAlign;
    if (s.bold) out.bold = true;
    if (s.italic) out.italic = true;
    if (s.fontFamily) out.fontFamily = s.fontFamily;
    if (s.shadow) out.shadow = true;
    if (s.showText === false) out.showText = false;
    if (s.src) out.src = s.src;
    if (s.action && s.action !== "none") out.action = s.action;
    if (s.target) out.target = s.target;
    if (s.checked != null) out.checked = !!s.checked;
    if (s.on != null) out.on = !!s.on;
    if (s.value != null) out.value = s.value;
    if (s.count != null) out.count = s.count;
    if (s.active != null) out.active = s.active;
    if (s.lines != null) out.lines = s.lines;
    if (s.controls) out.controls = s.controls;
    if (s.buttonSide) out.buttonSide = s.buttonSide;
    if (s.barFill) out.barFill = s.barFill;
    if (s.layout) out.layout = s.layout;
    if (isContainer(s)) out.align = normalizeAlign(s.align);
    if (isContainer(s)) out.justify = normalizeJustify(s.justify);
    if (s.widget === "section") out.showCaption = sectionCaptionVisible(s);
    if (s.gap != null) out.gap = s.gap;
    if (s.cols != null) out.cols = s.cols;
    if (s.wrap != null) out.wrap = !!s.wrap;
    if (s.overflow) out.overflow = s.overflow;
    if (s.scrollX != null) out.scrollX = s.scrollX;
    if (s.scrollY != null) out.scrollY = s.scrollY;
    if (s.bindScroll != null) out.bindScroll = !!s.bindScroll;
    if (s.interactionEnabled != null) out.interactionEnabled = !!s.interactionEnabled;
    if (s.toggleTarget) out.toggleTarget = s.toggleTarget;
    if (s.interactionControl) out.interactionControl = s.interactionControl;
    if (s.strokeOpacity != null) out.strokeOpacity = s.strokeOpacity;
    if (s.icon) out.icon = s.icon;
    if (s.iconSize != null) out.iconSize = s.iconSize;
    if (s.iconPosition) out.iconPosition = s.iconPosition;
    if (s.iconGap != null) out.iconGap = s.iconGap;
    if (isComposite(s)) {
      out.frame = JSON.parse(JSON.stringify(s.frame || {}));
      out.resizeMode = s.resizeMode || "reflow";
    }
    return out;
  }
  if (s.type === "rect" || s.type === "ellipse") {
    return {
      type: s.type, id: s.id || null, parent: s.parent || null, slot: s.slot != null ? s.slot : null,
      name: s.name || null,
      ...sizingData(s),
      text: s.text || null,
      x: Math.round(s.x), y: Math.round(s.y),
      w: Math.round(s.w), h: Math.round(s.h),
      radius: s.radius || 0,
      filled: s.filled !== false,
      fixed: !!s.fixed, z: zOf(s),
      opacity: s.opacity != null ? s.opacity : 100, margin: s.margin || 0, padding: s.padding || 0,
      fill: s.fill, stroke: s.stroke, strokeWidth: s.strokeWidth,
      strokeOpacity: s.strokeOpacity != null ? s.strokeOpacity : 100,
      fontSize: s.fontSize || 14, alignH: s.alignH || "center",
      alignV: s.alignV || "middle", textOverflow: s.textOverflow || "wrap", textColor: s.textColor || "#ffffff",
      center: { x: Math.round(s.x + s.w / 2), y: Math.round(s.y + s.h / 2) },
    };
  }
  const pts = s.pts.map((p) => ({ x: p.x, y: p.y }));
  const segCount = s.closed ? pts.length : pts.length - 1;
  const segments = [];
  let perimeter = 0;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const length = Math.round(dist(a, b) * 10) / 10;
    perimeter += length;
    segments.push({ from: a, to: b, length_px: length });
  }
  const out = {
    type: "area",
    name: s.name || null,
    label: s.label || null,
    color: s.color,
    closed: s.closed,
    points: pts,
    bbox: boundingBox(pts),
    segments,
    perimeter_px: Math.round(perimeter * 10) / 10,
  };
  if (s.closed && pts.length >= 3) out.area_px2 = Math.round(polygonArea(pts));
  return out;
}

// Committed shapes plus any in-progress (unfinished) area the user is drawing.
function exportableShapes() {
  const list = state.shapes.slice();
  if (state.building && state.building.pts.length) {
    const b = state.building.pts;
    if (b.length === 1) {
      list.push({ type: "point", x: b[0].x, y: b[0].y,
        label: document.getElementById("areaLabel").value.trim(), color: document.getElementById("areaColor").value });
    } else {
      list.push({ type: "area", pts: b.slice(), closed: false,
        name: document.getElementById("areaName").value.trim(),
        label: document.getElementById("areaLabel").value.trim(),
        color: document.getElementById("areaColor").value });
    }
  }
  return list;
}

// Template instructions embedded in every exported design so any AI that reads
// the JSON alone — without the separate AI_SKILL guide — reproduces this design's
// conventions the first time: it translates the mockup's accent hexes into theme
// tokens instead of hardcoding them, AND follows the native GNOME/KDE layout &
// UX patterns (gear-before-switch, bordered section cards, explanatory titles and
// subtitles) that the example designs use. Keep this in sync with the
// "Theme-following colours" and "Toolkit guidelines" sections of AI_SKILL.md.
const AI_THEME_TEMPLATE = {
  README: "Instructions for AI code generation. This mockup paints accent-role elements with concrete hexes (below) so the design reads faithfully. When you generate the REAL application code, DO NOT emit those accent hexes — map each to the theme token / style class so the built app follows whatever accent and light/dark the user has chosen. It also encodes the native layout & UX patterns under each toolkit's 'patterns' — reproduce those, not just the colours. Same 'no hardcoded colours, no CSS fighting the theme, follow the platform's conventions' rule the native example apps follow.",
  translate: "Anything on an ACCENT role: primary/suggested buttons, a switch's on-track, progress fill, a drop-zone's border/text, links/accent text, selection.",
  keepAsHex: "Only SEMANTIC STATUS tints (success/warning/error) and neutral surfaces with no matching token — and even then prefer a translucent tint, e.g. alpha(#hex, 0.16), so it survives dark mode.",
  gtk4: {
    note: "Prefer built-in STYLE CLASSES over colour references — they already carry the theme accent and its correct foreground.",
    styleClasses: {
      "primary / accent button": ".suggested-action",
      "destructive button": ".destructive-action",
      "card / surface panel": ".card",
      "big title": ".title-1 … .title-4",
      "subtitle / caption / status text": ".dim-label",
      "section heading": ".heading",
      "rounded / pill button": "add .pill",
      "progress bar fill": "nothing — Gtk.ProgressBar fills in the theme accent automatically",
    },
    accentColorReference: "When custom CSS genuinely needs the accent colour (dashed drop-zone border, accent text on a tinted panel), use @theme_selected_bg_color (accent/selection bg) and @theme_selected_fg_color (text on it).",
    avoid: "Do NOT use @accent_bg_color / @accent_color — those are libadwaita-only names; stock GTK themes such as Mint-Y do not define them, so the reference silently fails in an app-level CssProvider and the element renders faint or default. @theme_selected_bg_color is defined by essentially every GTK theme.",
    customCss: "Keep custom CSS to GEOMETRY only — border-radius, padding, min-height. Load it at GTK_STYLE_PROVIDER_PRIORITY_APPLICATION so it layers over the theme without overriding its colours.",
    patterns: {
      note: "GNOME/GTK layout & UX conventions this design uses — reproduce them, do not invent a flat wall of controls. Map to GtkFrame / Adw.PreferencesGroup / Adw.ActionRow / GtkSwitch in the real app.",
      rowGearForSettings: "When a switch/toggle governs something that has its OWN further settings, place a round FLAT gear toolbutton (⚙, icon-only, no fill, no border) immediately BEFORE the switch. It opens the detail dialog/subpage for exactly the thing that switch controls, and keeps every switch aligned at the row's trailing edge. Do NOT add a separate 'Edit…' text button for this — the gear IS the affordance. (Maps to a flat GtkButton with an icon, or Adw.ActionRow with a gear suffix + the switch.)",
      borderedSections: "Group related rows inside a BORDERED section card — the GNOME boxed list (.boxed-list) or .card: one rounded outer border, rows separated by BOTTOM-ONLY 1px dividers (borderSides bottom only). Never leave switches/controls floating on the bare window background.",
      titlesAndSubtitles: "Every section/group carries a heading TITLE and a SUBTITLE/description that explains what it does, and each row can carry its own title plus a dim subtitle. The UI/UX explanation lives in these titles/subtitles (.heading / .title-* / .dim-label / Adw group title+description), NEVER crammed into a control's label. This is what makes the interface self-explaining.",
      rowLayout: "A settings row reads left→right: leading title (+ optional dim subtitle) on the left, a growing spacer, then the trailing control cluster (optional gear, then the switch/value/chevron). Keep the trailing controls right-aligned and consistent across every row.",
      contentNavigation: "To separate content into logical top-level sections, use a SIDEBAR — a vertical list of destinations — driving a page STACK, NOT a tab bar. Each sidebar item switches the visible page and hides its siblings (the nav button's action=switch + target, with one section per page inside a 'Page stack'). Pin low-priority items (version, About) to the bottom of the sidebar with a growing spacer above them. Maps to Adw.NavigationSplitView / GtkStackSidebar + GtkStack. Reserve TABS for peer documents/views WITHIN a page, never for the app's top-level sections.",
      commitActionBar: "When a screen batches changes behind Apply/OK (checkboxes, not live switches), give it a bottom action bar: a growing spacer pushes the buttons to the trailing edge, a secondary/destructive button (Revert/Cancel) sits left of the primary (Apply). Equal heights, .suggested-action on the primary and .destructive-action where the action discards work.",
      modalDialogs: "A task that must be completed or dismissed before continuing (enroll, rename, enter a PIN, confirm) is a MODAL DIALOG that dims/darkens the rest of the window behind a scrim — NOT a separate top-level window and NOT an inline panel. The dimmed backdrop signals 'finish this or close it'. Structure: title, body, then a bottom action bar with Cancel on the leading edge and the primary action trailing. Maps to Adw.Dialog / Adw.MessageDialog (or a modal GtkWindow set transient-for its parent), which draw the scrim for you. (In a mockup these are separate window shapes because the canvas has no overlay layer — implement them as a modal over the parent, not a real second window.)",
      responsiveVariants: "Ship compact + regular variants of a screen (this design carries both). On narrow widths the sidebar collapses from a permanent column into a toggle/drawer, and rows reflow — content stays reachable, nothing is clipped. Maps to Adw breakpoints / an Adw.OverlaySplitView (or GtkStackSidebar) that folds. Use the design's hideBelow/showBelow to express which elements swap at a breakpoint.",
      headerBackNavigation: "Drilling into a SUBPAGE adds a Back button at the LEADING edge of the header bar to pop to the parent — this complements the sidebar, which switches top-level sections. Maps to Adw.NavigationView push/pop with its automatic back button. Sidebar = lateral top-level moves; header Back = depth within a section.",
      statusTinting: "Colour-code list/row items by TYPE or STATE so the category is readable at a glance (the PDFExtractor design tints each file row by processing state: ready/fast = a translucent SUCCESS-green tint fill with a green border, green text and a ⚡ glyph; needs-OCR/slow = a WARNING-amber tint with amber border+text and a 🐌 glyph). Rules: (1) keep tint, border and text in the SAME hue family; (2) draw from the semantic families success/warning/error as a translucent tint (alpha ~0.12–0.16) so it survives dark mode; (3) ALWAYS pair the colour with a glyph AND text — never colour alone, so colour-blind users can still read the state. Map to a .card row with a per-state CSS class tinting @success_color / @warning_color / @error_color, or an Adw row with a status icon.",
      contentInspectorSplit: "For a work area plus its options, use a horizontal SPLIT: the primary content pane on the leading side (wider, ~65%) and a narrower settings/inspector pane trailing (~35%), each a white card. This is content + its settings side-by-side, NOT top-level navigation (that's the sidebar). Maps to Adw.OverlaySplitView or a GtkPaned holding two GtkFrame cards.",
      dropZone: "A drag target is an accent-tinted panel: a translucent accent fill, an accent (often dashed) border, accent-coloured instructional text centred inside, AND an explicit fallback button ('…or click Add files') — never drag-only, since drag isn't discoverable or accessible. Use @theme_selected_bg_color for the border/text (see the colour-translation table); keep custom CSS geometry-only.",
      surfaceHierarchy: "The 'clean' look comes from a clear surface stack: a softly TINTED window/workspace background (not pure white), WHITE content cards raised on it with a soft 1px neutral border and a generous corner radius (~14), and roomy padding (20–28px) inside cards with comfortable gaps between rows. Don't pack controls edge-to-edge — the whitespace is doing the work.",
      roundedCorners: "Rounded corners follow a consistent SCALE by role, not one radius everywhere: window ≈12, cards/sections ≈12–14, controls (buttons, textboxes, dropdowns, split panes) ≈8, chips/list rows ≈6, progress bars & checkboxes ≈4, and toggles/pills fully rounded (radius = height/2). NESTING RULE: an inner element's radius is ≤ its container's, and inset by roughly the padding, so a child never looks rounder than the card holding it. Reuse the SAME radius for the SAME role across the whole UI. In real code these are geometry-only border-radius values (allowed in custom CSS) — pick values that sit with the theme's own rounding rather than fighting it.",
      actionMicrocopy: "Make the UI self-narrating: the primary button states the concrete effect INCLUDING a count ('Extract 3 PDFs', not 'Extract'); a status line near it gives readiness + an estimate ('Ready · estimated OCR time 18 minutes'); summary lines pack facts with middot separators ('3 files · 248 pages · 2 fast · 1 needs OCR'). Generate these strings from real state in code.",
      reference: "This is exactly the pattern the AppLocker, GNOME Settings and PDFExtractor example designs follow — treat them as the reference for GTK/GNOME targets.",
    },
  },
  kde: {
    note: "Use theme roles, never hex.",
    roles: {
      accent: "Kirigami.Theme.highlightColor  (buttons' checked/selection state, progress, drop-zone border)",
      content: "Kirigami.Theme.textColor / Kirigami.Theme.backgroundColor",
      controls: "native controls (Button with a highlighted role, Kirigami.Card) so the Breeze accent and colour scheme apply automatically",
    },
    patterns: {
      note: "KDE/Kirigami equivalents of the same conventions.",
      rowConfigForSettings: "For a switch row that has its own settings, put a flat icon Button (a 'configure'/gear icon) before the Switch so switches stay aligned at the trailing edge; it opens that row's config page/dialog.",
      groupedForm: "Lay related controls out in a Kirigami.FormLayout or inside a Kirigami.Card with a visible boundary; give each group a section header and a descriptive line rather than floating controls on the page.",
      titlesAndSubtitles: "Each group has a header title and a description; rows carry a label plus secondary/dim explanatory text so the UI explains itself.",
      contentNavigation: "Separate top-level sections with a sidebar/drawer + page stack (Kirigami.PageRow / Kirigami.GlobalDrawer), not a TabBar; keep tabs for peer views within a page. Commit-style screens get a footer action bar with the primary button at the trailing edge.",
      modalDialogs: "Blocking tasks are a modal Kirigami.Dialog / QML Dialog with its dimmed overlay, not a second window and not an inline panel; Cancel leading, primary trailing.",
      responsiveVariants: "Provide compact + regular layouts; on narrow widths the sidebar folds into a Kirigami drawer and rows reflow rather than clip.",
      headerBackNavigation: "Subpages get a Back button via Kirigami.PageRow pop; the drawer handles lateral top-level moves, Back handles depth.",
      statusTinting: "Tint rows by state with Kirigami.Theme positive/neutral/negative background colours plus a matching icon and text; never colour alone.",
      contentInspectorSplit: "Content + options = a two-pane split (a RowLayout of two Kirigami.Card, or ColumnView), primary wider and inspector narrower — not navigation.",
      dropZone: "A drag target is an accent-tinted area (Kirigami.Theme.highlightColor border/text) with a click-to-add fallback button; never drag-only.",
      surfaceHierarchy: "Tinted page background, raised Kirigami.Card content with soft borders and generous padding; let whitespace carry the layout.",
      roundedCorners: "Breeze uses a tighter radius scale — cards/windows ≈4–6, controls ≈3–4, small indicators ≈3, pills fully rounded; keep the SAME radius per role and never let a child look rounder than its container.",
      actionMicrocopy: "Primary button states the concrete effect + count; a status line gives readiness/estimate; summaries use middot-separated facts.",
    },
  },
  switches: "Every switch is three theme roles: a neutral thumb, a neutral off-track, and an accent on-track. The thumb never takes the track's state colour; the track communicates off vs on.",
  icons: "Use the PROVIDED built-in SVGs for icons — list them with the `assets` command or GET /assets before inventing anything (the set is broad: arrows, chevrons, gear, search, files, lock/unlock, face-id, media, brush, trash, warning, users, and more). When a needed icon genuinely isn't in the set, AUTHOR A NEW ONE in the SAME visual style as the provided icons rather than pasting a mismatched third-party icon or dropping an emoji where a line icon belongs. House style: viewBox='0 0 24 24', fill:none, a single stroke using currentColor (so it follows the theme text/accent), stroke-width 2, stroke-linecap and stroke-linejoin round. Drop new SVGs into the user assets folder (~Pictures/PixelRuller/assets) and reference them as user/<file>. Keep every icon in the UI one coherent family — consistent stroke weight, corner rounding, and metaphor.",
};

// Build the canonical design document: everything needed to reload the design,
// plus computed metrics for each shape. This is the single source of truth.
function buildExport() {
  const shapes = exportableShapes().map(serializeShape);
  return {
    app: "PixelRuller",
    version: 1,
    mode: state.docMode,
    canvas: {
      width: state.W,
      height: state.H,
      background: state.background ? "screenshot" : "blank",
      bgColor: state.bgColor,
    },
    grid: { on: state.grid.on, spacing_px: state.grid.spacing },
    // Round-trips a design's own template if it carries one; otherwise stamps
    // the current canonical template so older files gain it on next export.
    aiTheme: state.aiTheme || AI_THEME_TEMPLATE,
    count: shapes.length,
    shapes,
  };
}

// Reconstruct the working state from a design document (inverse of buildExport).
// A screenshot background isn't stored in JSON, so screenshot designs reload
// onto a blank canvas of the same size (shapes keep their exact coordinates).
function loadDesign(doc) {
  if (!doc || !Array.isArray(doc.shapes)) throw new Error("not a PixelRuller design (no shapes[])");
  const c = doc.canvas || doc.screenshot || {};
  let w = Number(c.width) || 0, h = Number(c.height) || 0;
  if (!w || !h) { // fall back to the shapes' bounding box
    const all = [];
    for (const s of doc.shapes) {
      if (s.type === "point") all.push({ x: s.x, y: s.y });
      else (s.points || []).forEach(p => all.push(p));
    }
    const bb = boundingBox(all.length ? all : [{ x: 0, y: 0 }, { x: 1920, y: 1080 }]);
    w = bb.x + bb.width; h = bb.y + bb.height;
  }
  state.bgColor = c.bgColor || "#ffffff";
  newCanvas(w, h); // blank canvas of the right size (clears shapes; resets aiTheme)
  state.aiTheme = doc.aiTheme || null; // preserve a design's own template across a round-trip
  const loadSizing = (s) => ({
    sizeModeX: s.sizeModeX || "fixed", sizeModeY: s.sizeModeY || "fixed", grow: Number(s.grow) || 0,
    widthPercent: s.widthPercent != null ? Math.max(0, Math.min(100, Number(s.widthPercent))) : 100,
    heightPercent: s.heightPercent != null ? Math.max(0, Math.min(100, Number(s.heightPercent))) : 100,
    minW: Number(s.minW) || 0, maxW: Number(s.maxW) || 0,
    minH: Number(s.minH) || 0, maxH: Number(s.maxH) || 0,
    colSpan: Math.max(1, Number(s.colSpan) || 1), rowSpan: Math.max(1, Number(s.rowSpan) || 1),
    hideBelow: Math.max(0, Number(s.hideBelow) || 0), showBelow: Math.max(0, Number(s.showBelow) || 0),
  });
  state.shapes = doc.shapes.map(s => {
    if (s.type === "point") {
      return { type: "point", x: s.x, y: s.y, label: s.label || "", color: s.color || "#ff3b30" };
    }
    if (s.type === "icon") {
      return { type: "icon", id: s.id || null, parent: s.parent || null,
        ...loadSizing(s),
        slot: s.slot != null ? s.slot : null, name: s.name || "", src: s.src,
        x: s.x, y: s.y, w: s.w, h: s.h, fixed: !!s.fixed, z: s.z || 0 };
    }
    if (s.type === "widget") {
      return { type: "widget", id: s.id || null, parent: s.parent || null,
        ...loadSizing(s),
        slot: s.slot != null ? s.slot : null, widget: s.widget, toolkit: s.toolkit || null,
        variantOf: s.variantOf || null, variantLabel: s.variantLabel || null,
        name: s.name || "", x: s.x, y: s.y, w: s.w, h: s.h, radius: s.radius || 0,
        fixed: !!s.fixed, z: s.z || 0, opacity: s.opacity != null ? s.opacity : 100,
        margin: s.margin || 0, padding: s.padding || 0, fill: s.fill, stroke: s.stroke,
        strokeWidth: s.strokeWidth != null ? s.strokeWidth : 1,
        text: s.text || "", fontSize: s.fontSize || 14, textColor: s.textColor || "#111827",
        alignH: s.alignH || null, alignV: s.alignV || null, textOverflow: s.textOverflow || "wrap",
        checked: s.checked, on: s.on, value: s.value, count: s.count,
        active: s.active, lines: s.lines, controls: s.controls,
        buttonSide: s.buttonSide, barFill: s.barFill, layout: s.layout, align: normalizeAlign(s.align),
        justify: normalizeJustify(s.justify),
        gap: s.gap, cols: s.cols, wrap: !!s.wrap, overflow: s.overflow || "visible",
        scrollX: Number(s.scrollX) || 0, scrollY: Number(s.scrollY) || 0,
        bindScroll: !!s.bindScroll, interactionEnabled: s.interactionEnabled != null ? !!s.interactionEnabled : undefined,
        toggleTarget: s.toggleTarget || "", interactionControl: s.interactionControl || "", strokeOpacity: s.strokeOpacity,
        icon: s.icon || null, iconSize: Number(s.iconSize) || undefined,
        iconPosition: s.iconPosition || null, iconGap: Number(s.iconGap) || 0,
        frame: s.frame ? JSON.parse(JSON.stringify(s.frame)) : undefined,
        resizeMode: s.resizeMode || "reflow",
        strokeStyle: s.strokeStyle || undefined,
        borderSides: s.borderSides != null ? { ...s.borderSides } : undefined,
        captionMode: s.captionMode || undefined, captionSide: s.captionSide || undefined,
        captionAlign: s.captionAlign || undefined,
        bold: !!s.bold || undefined, italic: !!s.italic || undefined,
        fontFamily: s.fontFamily || undefined, shadow: !!s.shadow || undefined,
        showText: s.showText === false ? false : undefined,
        src: s.src || undefined,
        action: s.action || undefined, target: s.target || undefined,
        showCaption: s.widget === "section" ? (s.showCaption != null ? !!s.showCaption : !!String(s.text || "").trim()) : undefined };
    }
    if (s.type === "rect" || s.type === "ellipse") {
      return {
        type: s.type, id: s.id || null, parent: s.parent || null,
        ...loadSizing(s),
        slot: s.slot != null ? s.slot : null, name: s.name || "", label: s.label || "",
        x: s.x, y: s.y, w: s.w, h: s.h, radius: s.radius || 0,
        filled: s.filled !== false, fixed: !!s.fixed, z: s.z || 0,
        opacity: s.opacity != null ? s.opacity : 100, margin: s.margin || 0, padding: s.padding || 0,
        fill: s.fill || "#4a9eff", stroke: s.stroke || "#2f7de0",
        strokeWidth: s.strokeWidth != null ? s.strokeWidth : 1,
        strokeOpacity: s.strokeOpacity, text: s.text || "",
        fontSize: s.fontSize || 14, alignH: s.alignH || "center",
        alignV: s.alignV || "middle", textOverflow: s.textOverflow || "wrap", textColor: s.textColor || "#ffffff",
      };
    }
    return {
      type: "area",
      pts: (s.points || s.pts || []).map(p => ({ x: p.x, y: p.y })),
      closed: !!s.closed,
      name: s.name || "",
      label: s.label || "",
      color: s.color || "#ff3b30",
    };
  });
  // Honor the document's mode, else infer it from the shape types present.
  const hasElements = state.shapes.some(isElement);
  state.docMode = doc.mode || (hasElements ? "canvas" : "screenshot");
  if (state.docMode === "screenshot") { // measuring labels are the point there
    state.showNumbers = true;
    document.getElementById("showNumbers").checked = true;
  }
  applyModeUI();
  if (doc.grid) {
    state.grid.on = !!doc.grid.on;
    state.grid.spacing = Number(doc.grid.spacing_px) || state.grid.spacing;
    document.getElementById("gridSpacing").value = state.grid.spacing;
    const gt = document.getElementById("gridToggle");
    gt.textContent = state.grid.on ? "On" : "Off";
    gt.classList.toggle("active", state.grid.on);
  }
  ensureIds(); // fill missing ids, keep the counter ahead of loaded ones
  relayout(); // stack windows + arrange managed containers on load
  render();
  toast(`Loaded design — ${state.shapes.length} shape(s), ${state.W}×${state.H}`);
}

function loadDesignFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { loadDesign(JSON.parse(reader.result)); }
    catch (err) { toast("Load failed: " + err.message, true); }
  };
  reader.onerror = () => toast("Could not read file", true);
  reader.readAsText(file);
}

// Load a same-origin design from a shareable URL such as
// `?design=PDFExtractorUI.json`. This keeps example/test canvases reproducible
// without bypassing the normal canonical JSON loader.
async function loadDesignFromUrl(path) {
  try {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin) throw new Error("design URL must be local");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadDesign(await res.json());
    if (new URLSearchParams(location.search).get("preview") === "html") {
      const code = await buildHtmlCode();
      document.open(); document.write(code); document.close();
      return;
    }
    fitToView();
    render();
  } catch (err) {
    showStart();
    toast("Could not load design: " + err.message, true);
  }
}

function boundingBox(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// ----- Flow chart (simple text) -----------------------------------------
const centerIn = (s, w) => {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  return cx >= w.x && cx <= w.x + w.w && cy >= w.y && cy <= w.y + w.h;
};

// A plain-text outline: each Window and the widgets that sit inside it.
function buildFlowText() {
  const label = (s) => {
    const kind = s.type === "widget" ? s.widget : s.type;
    const txt = s.text ? ` "${s.text}"` : "";
    return `${s.name || kind} [${kind}]${txt} @ ${Math.round(s.x)},${Math.round(s.y)} ${Math.round(s.w)}×${Math.round(s.h)}`;
  };
  const wins = state.shapes.filter(s => s.type === "widget" && s.widget === "window");
  const inWin = new Set();
  const lines = [`PixelRuller flow — canvas ${state.W}×${state.H} (${state.docMode} mode)`, ""];
  for (const w of wins) {
    lines.push(`WINDOW: ${w.name || "Window"}  (${Math.round(w.w)}×${Math.round(w.h)} @ ${Math.round(w.x)},${Math.round(w.y)})`);
    const kids = state.shapes.filter(s => s !== w && isElement(s) && s.widget !== "window" && centerIn(s, w));
    kids.sort((a, b) => a.y - b.y || a.x - b.x);
    kids.forEach(k => { inWin.add(k); lines.push("  - " + label(k)); });
    if (!kids.length) lines.push("  (empty)");
    lines.push("");
  }
  const loose = state.shapes.filter(s => isElement(s) && s.widget !== "window" && !inWin.has(s));
  if (loose.length) { lines.push("LOOSE (not in a window):"); loose.forEach(k => lines.push("  - " + label(k))); lines.push(""); }
  lines.push("# connections/actions: TODO (add actions to widgets to draw the flow)");
  return lines.join("\n");
}

async function saveFlowText() {
  if (!state.ready) { toast("Nothing to export yet", true); return; }
  const name = (document.getElementById("areaName").value.trim() || "design") + "_flow";
  try {
    const res = await fetch("/save-text", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text: buildFlowText() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    toast("Flow saved → " + data.path);
  } catch (err) {
    toast("Flow export failed: " + err.message, true);
  }
}

// ----- XML export (nested canvas > window > widget tree) ----------------
const xmlEsc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function elementXml(s, indent) {
  const pad = "  ".repeat(indent);
  const tag = s.type === "widget" ? s.widget : s.type;
  const a = [`name="${xmlEsc(s.name || tag)}"`,
    `x="${Math.round(s.x)}" y="${Math.round(s.y)}" w="${Math.round(s.w)}" h="${Math.round(s.h)}"`];
  const look = isComposite(s) ? (s.frame || {}) : s;
  if (look.radius) a.push(`radius="${look.radius}"`);
  if (isComposite(s)) {
    const r = cornerRadii(s);
    a.push(`radius-tl="${r.tl}" radius-tr="${r.tr}" radius-br="${r.br}" radius-bl="${r.bl}"`);
    a.push(`resize-mode="${xmlEsc(s.resizeMode || "reflow")}"`);
  }
  if (s.text) a.push(`text="${xmlEsc(s.text)}"`);
  if (s.variantOf) a.push(`variant-of="${xmlEsc(s.variantOf)}"`);
  if (s.variantLabel) a.push(`variant-label="${xmlEsc(s.variantLabel)}"`);
  if (s.src) a.push(`src="${xmlEsc(s.src)}"`);
  if (s.icon) a.push(`icon="${xmlEsc(s.icon)}"`);
  if (s.iconSize) a.push(`icon-size="${s.iconSize}"`);
  if (s.iconPosition) a.push(`icon-position="${xmlEsc(s.iconPosition)}"`);
  if (look.fill && look.fill !== "none") a.push(`fill="${look.fill}"`);
  if (look.stroke) a.push(`stroke="${look.stroke}"`);
  if (look.strokeWidth != null) a.push(`stroke-width="${look.strokeWidth}"`);
  if (s.opacity != null) a.push(`opacity="${s.opacity}"`);
  if (s.fontSize) a.push(`font-size="${s.fontSize}"`);
  if (s.textColor) a.push(`text-color="${s.textColor}"`);
  if (s.alignH) a.push(`text-align="${xmlEsc(s.alignH)}"`);
  if (s.alignV) a.push(`text-align-v="${xmlEsc(s.alignV)}"`);
  if (s.textOverflow) a.push(`text-overflow="${xmlEsc(s.textOverflow)}"`);
  if (s.widget === "section") a.push(`show-caption="${sectionCaptionVisible(s)}"`);
  if (s.strokeStyle) a.push(`border-style="${xmlEsc(s.strokeStyle)}"`);
  if (s.borderSides != null) {
    const B = borderSides4(s);
    a.push(`border-sides="${["t", "r", "b", "l"].filter(k => B[k]).join(",")}"`);
  }
  if (s.captionMode) a.push(`caption-mode="${xmlEsc(s.captionMode)}"`);
  if (s.captionSide) a.push(`caption-side="${xmlEsc(s.captionSide)}"`);
  if (s.captionAlign) a.push(`caption-align="${xmlEsc(s.captionAlign)}"`);
  if (s.bold) a.push('bold="true"');
  if (s.italic) a.push('italic="true"');
  if (s.fontFamily) a.push(`font-family="${xmlEsc(s.fontFamily)}"`);
  if (s.shadow) a.push('shadow="true"');
  if (s.showText === false) a.push('show-text="false"');
  if (s.action && s.action !== "none") a.push(`action="${xmlEsc(s.action)}"`);
  if (s.target) a.push(`target="${xmlEsc(s.target)}"`);
  a.push(`size-x="${xmlEsc(s.sizeModeX || "fixed")}" size-y="${xmlEsc(s.sizeModeY || "fixed")}"`);
  if (s.sizeModeX === "percent") a.push(`width-percent="${s.widthPercent != null ? s.widthPercent : 100}"`);
  if (s.sizeModeY === "percent") a.push(`height-percent="${s.heightPercent != null ? s.heightPercent : 100}"`);
  if (s.grow) a.push(`grow="${s.grow}"`);
  if (s.minW) a.push(`min-w="${s.minW}"`); if (s.maxW) a.push(`max-w="${s.maxW}"`);
  if (s.minH) a.push(`min-h="${s.minH}"`); if (s.maxH) a.push(`max-h="${s.maxH}"`);
  if (s.hideBelow) a.push(`hide-below="${s.hideBelow}"`); if (s.showBelow) a.push(`show-below="${s.showBelow}"`);
  if (s.margin) { const m = side4(s.margin); a.push(`margin="${m.t},${m.r},${m.b},${m.l}"`); }
  if (s.padding) { const p = side4(s.padding); a.push(`padding="${p.t},${p.r},${p.b},${p.l}"`); }
  if (s.layout) a.push(`layout="${xmlEsc(s.layout)}"`);
  if (isContainer(s)) a.push(`align="${xmlEsc(normalizeAlign(s.align))}"`);
  if (isContainer(s)) a.push(`justify="${xmlEsc(normalizeJustify(s.justify))}"`);
  if (s.gap != null) a.push(`gap="${s.gap}"`);
  if (s.wrap) a.push(`wrap="true"`);
  if (s.cols) a.push(`columns="${s.cols}"`);
  if (s.overflow) a.push(`overflow="${xmlEsc(s.overflow)}"`);
  if (s.interactionEnabled != null) a.push(`interaction-enabled="${!!s.interactionEnabled}"`);
  if (s.toggleTarget) a.push(`toggle-target="${xmlEsc(s.toggleTarget)}"`);
  if (s.interactionControl) a.push(`interaction-control="${xmlEsc(s.interactionControl)}"`);
  if (s.checked != null) a.push(`checked="${!!s.checked}"`);
  if (s.on != null) a.push(`on="${!!s.on}"`);
  if (s.value != null) a.push(`value="${s.value}"`);
  if (s.fixed) a.push(`fixed="true"`);
  if (s.z) a.push(`z="${s.z}"`);
  const kids = isContainer(s) ? childrenOf(s).sort((x, y) => slotOf(x) - slotOf(y)) : [];
  if (!kids.length) return `${pad}<${tag} ${a.join(" ")}/>`;
  return [`${pad}<${tag} ${a.join(" ")}>`, ...kids.map(k => elementXml(k, indent + 1)), `${pad}</${tag}>`].join("\n");
}

function buildXml() {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<design app="PixelRuller" mode="${state.docMode}">`,
    `  <canvas width="${state.W}" height="${state.H}"/>`];
  const wins = state.shapes.filter(s => s.type === "widget" && s.widget === "window");
  for (const w of wins) {
    lines.push(elementXml(w, 1));
  }
  state.shapes.filter(s => isElement(s) && s.widget !== "window" && !s.parent && !parentContainer(s))
    .forEach(k => lines.push(elementXml(k, 1)));
  lines.push("</design>");
  return lines.join("\n");
}

async function saveXml() {
  if (!state.ready) { toast("Nothing to export yet", true); return; }
  const name = document.getElementById("areaName").value.trim() || "design";
  try {
    const res = await fetch("/save-text", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text: buildXml(), ext: ".xml" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    toast("XML saved → " + data.path);
  } catch (err) {
    toast("XML export failed: " + err.message, true);
  }
}

// ----- Runnable HTML/CSS export ----------------------------------------
// The generated DOM follows the same parent/slot tree as the canvas. Layout
// properties become CSS; only elements explicitly marked Fixed are absolute.
const htmlEsc = (v) => xmlEsc(v).replace(/'/g, "&#39;");
const cssPx = (v) => `${Math.max(0, Number(v) || 0)}px`;
const cssSides = (v) => { const s = side4(v); return `${cssPx(s.t)} ${cssPx(s.r)} ${cssPx(s.b)} ${cssPx(s.l)}`; };
const cssAlign = (v) => normalizeAlign(v) === "center" ? "center" : normalizeAlign(v) === "end" ? "flex-end"
  : normalizeAlign(v) === "stretch" ? "stretch" : "flex-start";
const cssJustify = (v) => ({ start: "flex-start", center: "center", end: "flex-end",
  "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" })[normalizeJustify(v)];
const cssTextAlign = (v) => ["left", "right", "center"].includes(v) ? v : "left";
const cssId = (s) => htmlEsc(s.id || s.name || s.widget || s.type);

function htmlContentBox(s) {
  const P = side4(s.padding, 12);
  const head = containerHeadOffset(s);
  return { x: s.x + P.l, y: s.y + P.t + head, P, head };
}

function htmlChildSizing(s, parent) {
  if (!parent) return [`width:min(${cssPx(s.w)},calc(100vw - 32px))`, `height:min(${cssPx(s.h)},calc(100vh - 32px))`];
  if (s.fixed) {
    const box = htmlContentBox(parent);
    return ["position:absolute", `left:${cssPx(s.x - box.x)}`, `top:${cssPx(s.y - box.y)}`,
      `width:${cssPx(s.w)}`, `height:${cssPx(s.h)}`];
  }
  const layout = parent.layout || "vertical";
  const siblings = childrenOf(parent).filter(k => !k.fixed);
  const gap = Number(parent.gap != null ? parent.gap : 12) || 0;
  const axis = layout === "horizontal" ? "x" : "y";
  const mode = axis === "x" ? s.sizeModeX : s.sizeModeY;
  const pctKey = axis === "x" ? "widthPercent" : "heightPercent";
  const size = axis === "x" ? s.w : s.h;
  const out = ["position:relative"];
  if (layout === "table") {
    out.push(`grid-column:span ${Math.max(1, s.colSpan || 1)}`, `grid-row:span ${Math.max(1, s.rowSpan || 1)}`);
  } else if (mode === "percent") {
    const raw = Math.max(0, Number(s[pctKey]) || 0);
    const total = siblings.filter(k => (axis === "x" ? k.sizeModeX : k.sizeModeY) === "percent")
      .reduce((n, k) => n + Math.max(0, Number(k[pctKey]) || 0), 0);
    const pct = total > 100 ? raw * 100 / total : raw;
    const adjustment = gap * Math.max(0, siblings.length - 1) * pct / 100;
    out.push(`flex:0 0 calc(${pct}% - ${adjustment}px)`);
  } else if (mode === "fill" || (s.grow || 0) > 0) {
    out.push(`flex:${Math.max(0.001, Number(s.grow) || 1)} 1 0`);
  } else if (mode === "hug") {
    out.push("flex:0 0 auto");
  } else {
    out.push(`flex:0 0 ${cssPx(size)}`);
  }
  const crossMode = axis === "x" ? s.sizeModeY : s.sizeModeX;
  const crossPct = axis === "x" ? s.heightPercent : s.widthPercent;
  const crossProp = axis === "x" ? "height" : "width";
  const crossSize = axis === "x" ? s.h : s.w;
  if (crossMode === "fill") out.push("align-self:stretch");
  else if (crossMode === "percent") out.push(`${crossProp}:${Math.max(0, Number(crossPct) || 0)}%`);
  else if (crossMode === "fixed") out.push(`${crossProp}:${cssPx(crossSize)}`);
  return out;
}

function htmlNodeStyle(s, parent) {
  const look = isComposite(s) ? (s.frame || {}) : s;
  const indicator = ["checkbox", "radio", "toggle", "slider", "scrollbar", "progress"].includes(s.widget);
  const out = ["box-sizing:border-box", ...htmlChildSizing(s, parent),
    `min-width:${cssPx(s.minW)}`, `min-height:${cssPx(s.minH)}`,
    `margin:${cssSides(s.margin)}`, `opacity:${(s.opacity != null ? s.opacity : 100) / 100}`,
    `color:${s.textColor || "#111827"}`, `font-size:${cssPx(s.fontSize || 14)}`,
    `text-align:${cssTextAlign(s.alignH)}`];
  if (s.textOverflow === "ellipsis") out.push("white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis");
  else if (s.textOverflow === "clip") out.push("white-space:nowrap", "overflow:hidden", "text-overflow:clip");
  else out.push("white-space:normal", "overflow-wrap:anywhere");
  if (s.maxW) out.push(`max-width:${cssPx(s.maxW)}`);
  if (s.maxH) out.push(`max-height:${cssPx(s.maxH)}`);
  if (indicator) out.push("background:transparent", `--sr-accent:${look.fill || "#4a9eff"}`, `accent-color:${look.fill || "#4a9eff"}`);
  else if (look.fill && look.fill !== "none") out.push(`background:${look.fill}`); else out.push("background:transparent");
  if (s.bold) out.push("font-weight:700");
  if (s.italic) out.push("font-style:italic");
  if (s.fontFamily) out.push(`font-family:${s.fontFamily}`);
  const sw = Math.max(0, Number(look.strokeWidth) || 0);
  const bs = (s.strokeStyle || "solid") === "dashed" ? "dashed" : "solid";
  const B = borderSides4(s);
  if (indicator || !sw) out.push("border:0");
  else if (B.t && B.r && B.b && B.l) out.push(`border:${sw}px ${bs} ${look.stroke || "transparent"}`);
  else {
    out.push("border:0");
    for (const [k, side] of [["t", "top"], ["r", "right"], ["b", "bottom"], ["l", "left"]])
      if (B[k]) out.push(`border-${side}:${sw}px ${bs} ${look.stroke || "transparent"}`);
  }
  out.push(`border-radius:${cssPx(look.radius || 0)}`);
  if (s.shadow) out.push(s.widget === "window"
    ? "box-shadow:0 10px 30px rgba(0,0,0,.35)" : "box-shadow:0 2px 8px rgba(0,0,0,.18)");
  if (!isContainer(s)) out.push(`padding:${cssSides(s.padding)}`);
  return out.join(";");
}

function htmlContainerStyle(s) {
  const layout = s.layout || "vertical", P = side4(s.padding, 12);
  const out = ["position:relative", "flex:1 1 auto", "min-width:0", "min-height:0", "width:100%", "height:100%",
    `padding:${cssSides(P)}`, `gap:${cssPx(s.gap != null ? s.gap : 12)}`,
    `overflow:${s.overflow === "scroll" ? (s.interactionEnabled === false ? "hidden" : "auto") : s.overflow === "clip" ? "hidden" : "visible"}`];
  if (layout === "table") out.push("display:grid", `grid-template-columns:repeat(${Math.max(1, s.cols || 1)},minmax(0,1fr))`);
  else out.push("display:flex", `flex-direction:${layout === "horizontal" ? "row" : "column"}`,
    `align-items:${cssAlign(s.align)}`, `justify-content:${cssJustify(s.justify)}`, `flex-wrap:${s.wrap ? "wrap" : "nowrap"}`);
  return out.join(";");
}

function htmlIcon(s, assets) {
  if (!s.icon) return "";
  const src = assets.get(s.icon) || `assets/${encodeURI(s.icon)}`;
  return `<img class="sr-icon" src="${htmlEsc(src)}" alt="" style="width:${cssPx(s.iconSize || 18)};height:${cssPx(s.iconSize || 18)}">`;
}

function htmlInteractionAttrs(s) {
  const out = [];
  let enabled = s.interactionEnabled === true, toggleTarget = enabled ? s.toggleTarget : "";
  const root = rootWindowOf(s), scope = root ? [root, ...descendantsOf(root)] : state.shapes;
  const refs = new Set([String(s.id || "").toLowerCase(), String(s.name || "").toLowerCase()]);
  const controlled = scope.find(candidate => candidate.interactionEnabled && candidate.interactionControl &&
    refs.has(String(candidate.interactionControl).toLowerCase()));
  if (controlled) { enabled = true; toggleTarget = controlled.name || controlled.id; }
  if (s.interactionEnabled != null || controlled) out.push(`data-interactive="${enabled}"`);
  if (toggleTarget) out.push(`data-toggle-target="${htmlEsc(toggleTarget)}"`);
  if (s.action && s.action !== "none" && s.target)
    out.push(`data-action="${htmlEsc(s.action)}"`, `data-action-target="${htmlEsc(s.target)}"`);
  if (s.widget === "scrollbar" && s.bindScroll) out.push('data-bind-scroll="parent"');
  return out.length ? " " + out.join(" ") : "";
}

function htmlLeaf(s, style, assets) {
  const text = s.showText === false ? "" : htmlEsc(s.text || ""), icon = htmlIcon(s, assets);
  const attrs = `id="${cssId(s)}" class="sr-node sr-${htmlEsc(s.widget || s.type)}" data-name="${htmlEsc(s.name || "")}"${htmlInteractionAttrs(s)} style="${style}"`;
  switch (s.widget) {
    case "button": case "toolbutton": case "menuitem": return `<button ${attrs}>${icon}${text}</button>`;
    case "textbox": case "searchfield": return `<input ${attrs} type="text" value="${text}">`;
    case "checkbox": return `<label ${attrs}><input type="checkbox"${s.checked ? " checked" : ""}><span>${text}</span></label>`;
    case "radio": return `<label ${attrs}><input type="radio"${s.checked ? " checked" : ""}><span>${text}</span></label>`;
    case "toggle": return `<label ${attrs}><input type="checkbox" role="switch"${s.on ? " checked" : ""}></label>`;
    case "dropdown": return `<select ${attrs}><option>${text}</option></select>`;
    case "slider": case "scrollbar": return `<input ${attrs} type="range" min="0" max="100" value="${Number(s.value) || 0}">`;
    case "progress": return `<progress ${attrs} max="100" value="${Number(s.value) || 0}"></progress>`;
    case "image": {
      const src = s.src ? (assets.get(s.src) || `assets/${encodeURI(s.src)}`) : "";
      return src ? `<img ${attrs} src="${htmlEsc(src)}" alt="${text}">` : `<div ${attrs}></div>`;
    }
    case "tabs": return `<nav ${attrs}>${[...Array(Math.max(1, s.count || 1))].map((_, i) => `<button${i === (s.active || 0) ? ' class="active"' : ""}>${text || "Tab"} ${i + 1}</button>`).join("")}</nav>`;
    case "wincontrols": return `<div ${attrs} aria-label="Window controls"><i class="min">−</i><i class="max">□</i><i class="close">×</i></div>`;
    case "separator": case "spacer": return `<div ${attrs}></div>`;
    default: return `<div ${attrs}>${icon}${text}</div>`;
  }
}

function htmlElement(s, parent, assets, indent = 2) {
  const pad = "  ".repeat(indent), style = htmlNodeStyle(s, parent);
  if (!isContainer(s)) return pad + htmlLeaf(s, style, assets);
  const kids = childrenOf(s).sort((a, b) => slotOf(a) - slotOf(b));
  const interaction = htmlInteractionAttrs(s);
  if (!kids.length && s.widget !== "section") {
    const justify = s.alignH === "right" ? "flex-end" : s.alignH === "center" ? "center" : "flex-start";
    const align = s.alignV === "bottom" ? "flex-end" : s.alignV === "middle" ? "center" : "flex-start";
    return `${pad}<div id="${cssId(s)}" class="sr-node sr-${htmlEsc(s.widget)}" data-name="${htmlEsc(s.name || "")}"${interaction} style="${style};display:flex;justify-content:${justify};align-items:${align};padding:${cssSides(s.padding)}">${s.showText === false ? "" : htmlEsc(s.text || "")}</div>`;
  }
  const legend = (s.captionMode || "block") === "border";
  const legendPos = (s.captionAlign || "left") === "center" ? "left:50%;transform:translateX(-50%)"
    : (s.captionAlign === "right" ? "right:10px" : "left:10px");
  const legendSide = (s.captionSide || "top") === "bottom" ? "bottom:-0.75em" : "top:-0.75em";
  const caption = sectionCaptionVisible(s)
    ? (legend
      ? `\n${pad}  <span class="sr-legend" style="position:absolute;${legendSide};${legendPos};background:${effectiveBg(s)};padding:0 6px;font-size:86%;line-height:1.4;z-index:1">${htmlEsc(s.text)}</span>`
      : `\n${pad}  <span class="sr-caption">${htmlEsc(s.text)}</span>`) : "";
  const childHtml = kids.map(k => htmlElement(k, s, assets, indent + 2)).join("\n");
  return `${pad}<div id="${cssId(s)}" class="sr-node sr-${htmlEsc(s.widget)}" data-name="${htmlEsc(s.name || "")}"${interaction} style="${style};display:flex;flex-direction:column">${caption}\n${pad}  <div class="sr-content" style="${htmlContainerStyle(s)}">\n${childHtml}\n${pad}  </div>\n${pad}</div>`;
}

function htmlResponsiveCss() {
  const rules = [];
  for (const s of state.shapes.filter(isElement)) {
    const id = String(s.id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!id) continue;
    if (s.showBelow > 0) {
      rules.push(`#${id}{display:none!important}`,
        `@container (max-width:${Math.max(0, Number(s.showBelow) - 0.01)}px){#${id}{display:revert!important}}`);
    }
    if (s.hideBelow > 0)
      rules.push(`@container (max-width:${Math.max(0, Number(s.hideBelow) - 0.01)}px){#${id}{display:none!important}}`);
  }
  return rules.join("\n    ");
}

async function embeddedAssets() {
  const refs = new Set();
  for (const s of state.shapes) { if (s.icon) refs.add(s.icon); if (s.type === "icon" || (s.widget === "image" && s.src)) refs.add(s.src); }
  const out = new Map();
  for (const ref of refs) {
    try {
      const res = await fetch(`/assets/${encodeURI(ref)}`); if (!res.ok) continue;
      const blob = await res.blob();
      const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
      out.set(ref, data);
    } catch (_) { /* preserve a relative fallback in generated code */ }
  }
  return out;
}

async function buildHtmlCode() {
  const assets = await embeddedAssets();
  const roots = state.shapes.filter(s => isElement(s) && !s.parent).sort((a, b) => a.y - b.y || a.x - b.x);
  const body = roots.map(s => htmlElement(s, null, assets)).join("\n");
  const responsive = htmlResponsiveCss();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${htmlEsc(roots[0]?.text || roots[0]?.name || "PixelRuller design")}</title>
  <style>
    *{box-sizing:border-box} html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif;background:#171b22}
    body{display:flex;flex-direction:column;align-items:center;gap:32px;padding:16px}.sr-node{font-family:inherit}.sr-window{position:relative;overflow:hidden;container-type:inline-size}
    .sr-caption{display:block;flex:0 0 22px;padding:5px 8px 0}.sr-icon{object-fit:contain;vertical-align:middle;margin-right:6px}
    button,input,select,progress{font:inherit;color:inherit}button{cursor:pointer}.sr-checkbox,.sr-radio{display:flex;align-items:center;gap:7px}.sr-checkbox>input,.sr-radio>input{appearance:none;width:17px;height:17px;flex:0 0 17px;margin:0;border:1px solid #6b7280;border-radius:3px;background:#fff;display:grid;place-content:center}.sr-radio>input{border-radius:50%}.sr-checkbox>input:checked,.sr-radio>input:checked{background:var(--sr-accent)}.sr-checkbox>input:checked:after{content:"";width:8px;height:4px;border-left:2px solid #111827;border-bottom:2px solid #111827;transform:translateY(-1px) rotate(-45deg)}.sr-radio>input:checked:after{content:"";width:7px;height:7px;border-radius:50%;background:#111827}.sr-toggle>input{appearance:none;width:44px;height:24px;margin:0;border:1px solid #9aa1ac;border-radius:999px;background:#c9ced6;padding:2px;display:flex;justify-content:flex-start}.sr-toggle>input:after{content:"";width:18px;height:18px;border-radius:50%;background:#e5e7eb;transition:transform .15s}.sr-toggle>input:checked{background:var(--sr-accent)}.sr-toggle>input:checked:after{background:#e5e7eb;transform:translateX(18px)}
    progress{appearance:none;overflow:hidden;background:#c9ced6}progress::-webkit-progress-bar{background:#c9ced6}progress::-webkit-progress-value{background:var(--sr-accent)}progress::-moz-progress-bar{background:var(--sr-accent)}
    .sr-wincontrols{display:flex;align-items:center;justify-content:flex-end;gap:8px}.sr-wincontrols i{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:rgba(127,127,127,.14);font-style:normal;font-size:15px;line-height:1}.sr-wincontrols i.close{font-size:18px}
    .sr-tabs{display:flex}.sr-tabs>*{flex:1}.sr-tabs .active{font-weight:700}.sr-separator{border-left:1px solid currentColor!important}.sr-spacer{border:0!important}
    ${responsive}
  </style>
</head>
<body>
${body}
<script>
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest('[data-interactive="true"][data-toggle-target]');
    if (!trigger) return;
    const root = trigger.closest('.sr-window') || document;
    const ref = trigger.dataset.toggleTarget;
    const target = [...root.querySelectorAll('[data-name]')].find(el => el.dataset.name === ref) || root.querySelector('#' + CSS.escape(ref));
    if (!target) return;
    const hidden = getComputedStyle(target).display === "none" || target.dataset.runtimeVisible === "false";
    target.dataset.runtimeVisible = hidden ? "true" : "false";
    target.style.setProperty("display", hidden ? "flex" : "none", "important");
  });
  document.addEventListener("click", (event) => {
    const el = event.target.closest('[data-action][data-action-target]');
    if (!el) return;
    const root = el.closest('.sr-window') || document;
    const target = [...root.querySelectorAll('[data-name]')].find(n => n.dataset.name === el.dataset.actionTarget)
      || root.querySelector('#' + CSS.escape(el.dataset.actionTarget));
    if (!target) return;
    const show = (node, visible) => node.style.setProperty("display", visible ? "flex" : "none", "important");
    const hidden = getComputedStyle(target).display === "none";
    const act = el.dataset.action;
    if (act === "toggle") show(target, hidden);
    else if (act === "show") show(target, true);
    else if (act === "hide") show(target, false);
    else if (act === "switch") {
      show(target, true);
      for (const sib of target.parentElement?.children || [])
        if (sib !== target && sib.classList.contains("sr-section")) show(sib, false);
    }
  });
  document.addEventListener("input", (event) => {
    const bar = event.target.closest('[data-interactive="true"][data-bind-scroll="parent"]');
    if (!bar) return;
    const host = bar.parentElement;
    if (!host) return;
    const ratio = Number(bar.value || 0) / 100;
    if (bar.offsetHeight > bar.offsetWidth) host.scrollTop = (host.scrollHeight - host.clientHeight) * ratio;
    else host.scrollLeft = (host.scrollWidth - host.clientWidth) * ratio;
  });
</script>
</body>
</html>`;
}

async function saveHtmlCode() {
  if (!state.ready || state.docMode !== "canvas") { toast("Start or load a canvas design first", true); return; }
  const name = (document.getElementById("areaName").value.trim() || "design") + "_code";
  try {
    const text = await buildHtmlCode();
    const res = await fetch("/save-text", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text, ext: ".html" }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    toast("Runnable HTML saved → " + data.path);
  } catch (err) { toast("Code export failed: " + err.message, true); }
}

// Deterministic engine contract used by browser verification and future CI.
// It exercises layout and every serialization surface without changing the
// user's open design.
function runLayoutSelfTests() {
  const savedShapes = state.shapes, savedMode = state.docMode;
  const results = [];
  const check = (name, condition, detail = "") => results.push({ name, ok: !!condition, detail });
  try {
    state.docMode = "canvas";
    const section = { id: "test_section", type: "widget", widget: "section", toolkit: "gtk4",
      name: "Actions", text: "Actions", showCaption: false, x: 0, y: 0, w: 300, h: 100,
      padding: 0, layout: "horizontal", align: "center", justify: "end", gap: 10 };
    const one = { id: "test_one", parent: section.id, slot: 0, type: "widget", widget: "button", toolkit: "gtk4",
      name: "One", text: "One", x: 0, y: 0, w: 50, h: 20, sizeModeX: "fixed", sizeModeY: "fixed" };
    const two = { ...one, id: "test_two", slot: 1, name: "Two", text: "Two" };
    state.shapes = [section, one, two];
    arrangeInto(section);
    check("justify-end", one.x === 190 && two.x === 250, `${one.x},${two.x}`);
    check("cross-axis-center", one.y === 40 && two.y === 40, `${one.y},${two.y}`);
    check("hidden-caption-no-offset", containerViewport(section).y === 0, String(containerViewport(section).y));
    const json = serializeShape(section), xml = elementXml(section, 0);
    check("json-roundtrip-fields", json.showCaption === false && json.justify === "end" && json.align === "center");
    check("xml-roundtrip-fields", xml.includes('show-caption="false"') && xml.includes('justify="end"'));
    check("html-layout-fields", htmlContainerStyle(section).includes("justify-content:flex-end"));
    const before = JSON.stringify(section);
    const invalid = validatedSet(["justify"], "sideways");
    check("invalid-set-rejected", !!invalid.error && JSON.stringify(section) === before, invalid.error || "mutated");
    const label = { type: "widget", widget: "label", toolkit: "gtk4", text: "A long description that wraps over several lines",
      w: 90, h: 20, fontSize: 14, padding: 0, textOverflow: "wrap", sizeModeY: "hug" };
    check("wrapped-hug-height", hugDimensions(label).h > 20, String(hugDimensions(label).h));
    // A hug container shrinks below the library's default section size.
    const col = { id: "test_col", type: "widget", widget: "section", toolkit: "gtk4", layout: "vertical",
      gap: 2, padding: 0, sizeModeY: "hug", showCaption: false, w: 100, h: 160 };
    const colA = { id: "test_colA", parent: "test_col", slot: 0, type: "widget", widget: "label", w: 100, h: 18 };
    const colB = { id: "test_colB", parent: "test_col", slot: 1, type: "widget", widget: "label", w: 100, h: 16 };
    state.shapes.push(col, colA, colB);
    check("container-hug-content", hugDimensions(col).h === 36, String(hugDimensions(col).h));
    // Borders: per-side export, dashed style, legend caption, text styling.
    const row = { id: "test_row", type: "widget", widget: "section", toolkit: "gtk4", name: "Row",
      w: 200, h: 40, layout: "horizontal", stroke: "#d5d0cc", strokeWidth: 1,
      borderSides: { t: false, r: false, b: true, l: false }, text: "Legend", showCaption: true,
      captionMode: "border", captionSide: "top", captionAlign: "center", strokeStyle: "dashed",
      bold: true, italic: true, fontFamily: "Cantarell" };
    state.shapes.push(row);
    const rowCss = htmlNodeStyle(row, null);
    check("per-side-border-css", rowCss.includes("border:0") && rowCss.includes("border-bottom:1px dashed #d5d0cc")
      && !rowCss.includes("border-top:"), rowCss.split(";").filter(x => x.startsWith("border")).join(";"));
    check("text-style-css", rowCss.includes("font-weight:700") && rowCss.includes("font-style:italic")
      && rowCss.includes("font-family:Cantarell"));
    const rowJson = serializeShape(row), rowXml = elementXml(row, 0);
    check("border-json", rowJson.borderSides.b === true && rowJson.borderSides.t === false
      && rowJson.strokeStyle === "dashed" && rowJson.captionMode === "border" && rowJson.bold === true);
    check("border-xml", rowXml.includes('border-sides="b"') && rowXml.includes('border-style="dashed"')
      && rowXml.includes('caption-mode="border"') && rowXml.includes('bold="true"'));
    check("legend-html", htmlElement(row, null, new Map()).includes('class="sr-legend"'));
    check("legend-no-head-offset", containerHeadOffset(row) === 0, String(containerHeadOffset(row)));
    const setSide = validatedSet(["borderSides", "b"], true);
    const setBad = validatedSet(["borderSides", "b"], 3);
    check("borderSides-set-validation", setSide.value === true && !!setBad.error);
    const win = { id: "test_window", type: "widget", widget: "window", w: 300, h: 200 };
    const target = { id: "test_target", parent: win.id, type: "widget", widget: "section", name: "Sidebar", w: 80, h: 100,
      interactionEnabled: true, interactionControl: "Trigger" };
    const probe = { id: "test_probe", parent: win.id, type: "widget", widget: "toolbutton", name: "Trigger",
      text: "<", x: 0, y: 0, w: 30, h: 30, hideBelow: 400 };
    state.shapes.push(win, target, probe);
    check("responsive-hide", responsiveVisible(probe) === false);
    win.w = 500;
    check("responsive-show", responsiveVisible(probe) === true);
    check("responsive-html", htmlResponsiveCss().includes("max-width:399.99px"));
    const interactionJson = serializeShape(target), interactionXml = elementXml(target, 0);
    check("interaction-target", interactionTargets(probe)[0] === target);
    check("interaction-json", interactionJson.interactionEnabled === true && interactionJson.interactionControl === "Trigger");
    check("interaction-xml", interactionXml.includes('interaction-enabled="true"') && interactionXml.includes('interaction-control="Trigger"'));
    check("interaction-html", htmlLeaf(probe, "", new Map()).includes('data-toggle-target="Sidebar"'));
    // Toolkit defaults reapplication: metrics + registry style, semantics kept.
    const btn = { id: "test_btn", parent: win.id, type: "widget", widget: "button", toolkit: "gtk4",
      name: "Save", text: "Save", x: 0, y: 0, w: 77, h: 19, radius: 2, fill: "#123456", checked: true };
    state.shapes.push(btn);
    const applied = applyToolkitDefaults(btn, "kde");
    check("defaults-metrics", applied === 1 && btn.w === 110 && btn.h === 30 && btn.radius === 4 && btn.toolkit === "kde",
      `${btn.w}×${btn.h} r${btn.radius}`);
    check("defaults-keeps-semantics", btn.text === "Save" && btn.name === "Save" && btn.checked === true);
    check("defaults-style", btn.fill === "#e7eaee" && btn.padding && btn.padding.l === 8);
    const winBefore = { w: win.w, h: win.h };
    applyToolkitDefaults(win, "gtk4");
    check("defaults-window-size-kept", win.w === winBefore.w && win.h === winBefore.h, `${win.w}×${win.h}`);
    check("defaults-bad-toolkit-rejected", execCommand("defaults test_btn qt").ok === false);
    // Button UI actions: switch shows the target and hides sibling sections.
    const paneA = { id: "test_paneA", parent: win.id, type: "widget", widget: "section", name: "Pane A", w: 50, h: 50 };
    const paneB = { id: "test_paneB", parent: win.id, type: "widget", widget: "section", name: "Pane B", w: 50, h: 50, runtimeVisible: false };
    const actBtn = { id: "test_actbtn", parent: win.id, type: "widget", widget: "button", name: "Go B",
      text: "B", w: 40, h: 20, action: "switch", target: "Pane B", shadow: true };
    state.shapes.push(paneA, paneB, actBtn);
    performUiAction(actBtn);
    check("action-switch", responsiveVisible(paneB) === true && responsiveVisible(paneA) === false);
    const actJson = serializeShape(actBtn), actXml = elementXml(actBtn, 0);
    check("action-json", actJson.action === "switch" && actJson.target === "Pane B" && actJson.shadow === true);
    check("action-xml", actXml.includes('action="switch"') && actXml.includes('target="Pane B"') && actXml.includes('shadow="true"'));
    check("action-html", htmlLeaf(actBtn, "", new Map()).includes('data-action="switch"')
      && htmlLeaf(actBtn, "", new Map()).includes('data-action-target="Pane B"'));
    check("shadow-css", htmlNodeStyle(actBtn, null).includes("box-shadow"));
    check("action-set-validation", !!validatedSet(["action"], "explode").error
      && validatedSet(["action"], "switch").value === "switch");
    // Show-text toggle: label suppressed everywhere, text preserved in data.
    actBtn.showText = false;
    check("showtext-html", !htmlLeaf(actBtn, "", new Map()).includes(">B<"));
    check("showtext-json", serializeShape(actBtn).showText === false && serializeShape(actBtn).text === "B");
    check("showtext-xml", elementXml(actBtn, 0).includes('show-text="false"'));
    check("showtext-set-validation", validatedSet(["showText"], false).value === false
      && !!validatedSet(["showText"], "maybe").error);
  } finally {
    state.shapes = savedShapes; state.docMode = savedMode;
    // Some checks render mid-test (e.g. performUiAction); repaint the real doc.
    if (state.ready) { relayout(); render(); }
  }
  return { ok: results.every(r => r.ok), results };
}
window.runLayoutSelfTests = runLayoutSelfTests;

async function exportJson() {
  if (!exportableShapes().length) { toast("Nothing to export yet — draw something first", true); return; }
  const name = document.getElementById("areaName").value.trim() || "measurement";
  try {
    const res = await fetch("/save-json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data: buildExport() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "export failed");
    toast("JSON saved → " + data.path);
  } catch (err) {
    toast("Export failed: " + err.message, true);
  }
}

// ----- Toast ------------------------------------------------------------
let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ----- Event wiring -----------------------------------------------------
function setActive(selector, el) {
  document.querySelectorAll(selector).forEach(b => b.classList.remove("active"));
  el.classList.add("active");
}

document.querySelectorAll(".mode").forEach(b => b.addEventListener("click", () => {
  state.mode = b.dataset.mode;
  setActive(".mode", b);
  if (state.mode === "point") finishArea(false);
  if (state.mode !== "select" && state.mode !== "move") clearSelection();
  canvas.style.cursor = cursorForMode();
  render();
}));

// Editing fill/radius updates the selected element live.
["fillColor", "radius"].forEach(id =>
  document.getElementById(id).addEventListener("input", applyInputsToSelection));

// Properties panel: every field edits the open element live.
PP("W").addEventListener("input", () => { PP("SizeX").value = "fixed"; });
PP("H").addEventListener("input", () => { PP("SizeY").value = "fixed"; });
["Name", "Text", "X", "Y", "W", "H", "Fixed", "Z", "Parent", "Filled", "Fill", "Stroke", "StrokeW",
 "StrokeO", "Radius", "Opacity", "MarT", "MarR", "MarB", "MarL", "PadT", "PadR", "PadB", "PadL",
 "SizeX", "SizeY", "PercentW", "PercentH", "Grow", "MinW", "MaxW", "MinH", "MaxH", "ColSpan", "RowSpan", "HideBelow", "ShowBelow",
 "Font", "AlignH", "AlignV", "TextOverflow", "ShowCaption", "TextColor", "Icon", "IconSize", "IconPosition", "IconGap",
 "Layout", "Align", "Justify", "Gap", "Cols", "Wrap", "Overflow", "ScrollX", "ScrollY",
 "StateBool", "StateVal", "StateCount", "ScrollBind", "InteractionEnabled", "ToggleTarget",
 "CornersLinked", "RadiusTL", "RadiusTR", "RadiusBR", "RadiusBL", "ResizeMode",
 "ShowText", "Bold", "Italic", "FontFamily", "Shadow", "StrokeStyle",
 "BorderT", "BorderR", "BorderB", "BorderL",
 "CaptionMode", "CaptionSide", "CaptionAlign", "Action", "ActionTarget"].forEach(k =>
  PP(k).addEventListener("input", applyPropPanel));
PP("Icon").addEventListener("change", () => {
  if (PP("Icon").value === "__pick__") pickExternalAsset();
});
document.getElementById("ppFront").addEventListener("click", bringFront);
document.getElementById("ppBack").addEventListener("click", sendBack);
document.getElementById("ppArrange").addEventListener("click", () => {
  if (state.propOpen !== null) arrangeChildren(state.shapes[state.propOpen]);
});
document.getElementById("ppEnterComposite").addEventListener("click", () => enterComposite());
document.getElementById("ppExitComposite").addEventListener("click", exitComposite);
document.getElementById("ppClose").addEventListener("click", () => { clearSelection(); render(); });
// Collapsible sections (hamburger-style), incl. the sidebar Tools section.
document.querySelectorAll("#sidebar .pp-sec-head").forEach(h =>
  h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed")));
document.getElementById("propPanel").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { clearSelection(); render(); canvas.focus(); }
});

// Style clipboard + theme palette.
document.getElementById("copyStyleBtn").addEventListener("click", copyStyle);
document.getElementById("pasteStyleBtn").addEventListener("click", pasteStyle);
document.getElementById("applyTheme").addEventListener("click", applyThemeToDesign);
buildPalette();

// Command line: Enter runs, ↑/↓ recall history, popup lists past commands.
(() => {
  const input = document.getElementById("cmdInput");
  const hist = document.getElementById("cmdHist");
  let histPos = -1; // -1 = fresh line; counts back from the end of cmdLog

  function renderCmdHist() {
    hist.innerHTML = cmdLog.slice(-10).map(e =>
      `<div class="cmd-line ${e.ok ? "" : "err"}" data-cmd="${e.cmd.replace(/"/g, "&quot;")}">` +
      `<span>${e.cmd}</span><em>${(e.msg || "").split("\n")[0]}</em></div>`).join("");
    hist.hidden = !cmdLog.length;
  }

  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep canvas shortcuts (Del, Ctrl+Z…) out of typing
    if (e.key === "Enter") {
      const cmd = input.value.trim();
      if (!cmd) return;
      const res = runCommand(cmd);
      histPos = -1;
      renderCmdHist();
      toast((res.msg || "").split("\n")[0], !res.ok);
      if (res.ok) input.value = "";
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (!cmdLog.length) return;
      e.preventDefault();
      histPos = e.key === "ArrowUp"
        ? Math.min(histPos + 1, cmdLog.length - 1)
        : Math.max(histPos - 1, -1);
      input.value = histPos === -1 ? "" : cmdLog[cmdLog.length - 1 - histPos].cmd;
    } else if (e.key === "Escape") {
      input.blur();
    }
  });
  input.addEventListener("focus", renderCmdHist);
  input.addEventListener("blur", () => setTimeout(() => { hist.hidden = true; }, 150));
  hist.addEventListener("mousedown", (e) => {
    const d = e.target.closest(".cmd-line");
    if (d) { input.value = d.dataset.cmd; setTimeout(() => input.focus(), 0); }
  });
})();

// "+" — add either a fresh toolkit window or a complete responsive/state
// variant. Every root remains visible in the vertically stacked window table.
const windowDialog = document.getElementById("windowDialog");
const windowForm = document.getElementById("windowForm");
const windowSource = document.getElementById("windowSource");
const windowSourceRow = document.getElementById("windowSourceRow");
const windowToolkitRow = document.getElementById("windowToolkitRow");

function selectedRootWindow() {
  let s = state.selected !== null ? state.shapes[state.selected] : null;
  while (s && !isWindow(s)) s = s.parent ? byId(s.parent) : null;
  return isWindow(s) ? s : state.shapes.find(isWindow);
}

function syncWindowDialogMode() {
  const mode = windowForm.elements.windowMode.value;
  windowSourceRow.hidden = mode !== "copy";
  windowToolkitRow.hidden = mode !== "empty";
  const source = byId(windowSource.value);
  if (mode === "copy" && source) {
    document.getElementById("windowWidth").value = source.w;
    document.getElementById("windowHeight").value = source.h;
    document.getElementById("windowName").value = `${source.name || "Window"} variant`;
  }
}

function openWindowDialog() {
  const wins = state.shapes.filter(isWindow);
  const active = selectedRootWindow() || wins[0];
  windowSource.innerHTML = wins.map(w =>
    `<option value="${htmlEsc(w.id)}">${htmlEsc(w.name || w.id)} — ${Math.round(w.w)}×${Math.round(w.h)}</option>`
  ).join("");
  if (active) windowSource.value = active.id;
  windowForm.elements.windowMode.value = wins.length ? "copy" : "empty";
  document.getElementById("windowToolkit").value = active?.toolkit || libToolkit;
  syncWindowDialogMode();
  windowDialog.hidden = false;
  document.getElementById("windowName").focus();
  document.getElementById("windowName").select();
}

function closeWindowDialog() { windowDialog.hidden = true; }

document.getElementById("addWin").addEventListener("click", openWindowDialog);
windowForm.addEventListener("change", (e) => {
  if (e.target.name === "windowMode" || e.target === windowSource) syncWindowDialogMode();
});
windowForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const mode = windowForm.elements.windowMode.value;
  const w = Number(document.getElementById("windowWidth").value) || 600;
  const h = Number(document.getElementById("windowHeight").value) || 400;
  const name = document.getElementById("windowName").value.trim() || "Window variant";
  let win = null;
  if (mode === "copy") {
    const source = byId(windowSource.value);
    if (!source) { toast("Choose a window to duplicate", true); return; }
    win = cloneWindowVariant(source, { w, h, name, variantLabel: name });
  } else {
    win = insertWindowPreset(document.getElementById("windowToolkit").value, { w, h, name, variantLabel: name });
  }
  if (win) {
    closeWindowDialog();
    fitToView();
    render();
  }
});
document.getElementById("windowCancel").addEventListener("click", closeWindowDialog);
document.getElementById("windowCancelX").addEventListener("click", closeWindowDialog);
windowDialog.addEventListener("mousedown", e => { if (e.target === windowDialog) closeWindowDialog(); });

// ⧉ next to each color: copy the hex to the clipboard.
document.querySelectorAll(".pp-copy").forEach(b => b.addEventListener("click", (e) => {
  e.preventDefault();
  const hex = document.getElementById(b.dataset.copy).value;
  navigator.clipboard?.writeText(hex);
  toast(`Copied ${hex}`);
}));

// Click a slider's value → type the exact number (Enter/blur applies).
document.querySelectorAll(".pp-val").forEach(span => span.addEventListener("click", () => {
  if (span.dataset.editing) return;
  span.dataset.editing = "1";
  const range = span.parentElement.querySelector('input[type="range"]');
  const inp = document.createElement("input");
  inp.type = "number";
  inp.className = "pp-val-edit";
  inp.value = span.textContent;
  span.replaceWith(inp);
  inp.focus(); inp.select();
  let finished = false;
  const commit = (apply) => {
    if (finished) return;
    finished = true;
    inp.replaceWith(span);
    delete span.dataset.editing;
    if (!apply) return;
    range.value = inp.value; // clamped to the slider's min/max
    range.dispatchEvent(new Event("input", { bubbles: true }));
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  inp.addEventListener("blur", () => commit(true));
}));

// Collapse / expand the left sidebar.
document.getElementById("sbCollapse").addEventListener("click", () => {
  document.body.classList.toggle("sb-collapsed");
  resizeCanvas();
});

document.getElementById("showNumbers").addEventListener("change", (e) => {
  state.showNumbers = e.target.checked;
  render();
});

document.getElementById("snapPoints").addEventListener("change", (e) => {
  state.snapPoints = e.target.checked;
  render();
});

document.getElementById("eqLen").addEventListener("change", (e) => {
  state.eqLen = e.target.checked;
  render();
});

document.getElementById("equalize").addEventListener("click", equalizeSelected);

// Editing name/label/color updates the selected shape (Select mode).
["areaName", "areaLabel", "areaColor"].forEach(id =>
  document.getElementById(id).addEventListener("input", applyInputsToSelection));

document.querySelectorAll(".snap").forEach(b => b.addEventListener("click", () => {
  state.snap = b.dataset.snap;
  setActive(".snap", b);
  render();
}));

document.getElementById("gridToggle").addEventListener("click", (e) => {
  state.grid.on = !state.grid.on;
  e.target.textContent = state.grid.on ? "On" : "Off";
  e.target.classList.toggle("active", state.grid.on);
  render();
});

document.getElementById("gridSpacing").addEventListener("input", (e) => {
  state.grid.spacing = Math.max(2, Number(e.target.value) || 50);
  render();
});

document.getElementById("capture").addEventListener("click", capture);
document.getElementById("save").addEventListener("click", save);
document.getElementById("exportJson").addEventListener("click", exportJson);
document.getElementById("exportCode").addEventListener("click", saveHtmlCode);
document.getElementById("flowText").addEventListener("click", saveFlowText);
document.getElementById("exportXml").addEventListener("click", saveXml);
document.getElementById("newDoc").addEventListener("click", showStart);

// Start-mode chooser actions
document.getElementById("startShot").addEventListener("click", () => { hideStart(); capture(); });
document.getElementById("startBlank").addEventListener("click", () => {
  const w = Number(document.getElementById("startW").value) || 1920;
  const h = Number(document.getElementById("startH").value) || 1080;
  newCanvas(w, h);
  seedSessionWindow(); // a design starts with one "Session" window
});

// A new blank canvas opens with a default Window named "Session" (PC apps have
// windows, not phone screens — analogous to Android activities).
function seedSessionWindow() {
  const m = Math.min(40, Math.round(Math.min(state.W, state.H) * 0.06));
  state.shapes.push({
    id: nextId(), parent: null, type: "widget", widget: "window", toolkit: libToolkit, name: "Session",
    x: m, y: m, w: state.W - 2 * m, h: state.H - 2 * m,
    radius: libToolkit === "kde" ? 4 : 12,
    fill: "#ffffff", stroke: "#c9ced6", strokeWidth: 1,
    text: "Session", fontSize: 14, textColor: "#111827", fixed: false, z: nextZ(),
  });
  const win = state.shapes[state.shapes.length - 1];
  composeWindowPreset(win, libToolkit);
  clearSelection();
  refreshTree();
  render();
}

// Load a design.json from disk (client-side file picker)
const fileInput = document.getElementById("fileInput");
const openFile = () => fileInput.click();
document.getElementById("loadJson").addEventListener("click", openFile);
document.getElementById("startLoad").addEventListener("click", openFile);
fileInput.addEventListener("change", (e) => {
  if (e.target.files[0]) loadDesignFromFile(e.target.files[0]);
  e.target.value = ""; // allow re-loading the same file
  hideStart();
});
document.getElementById("finish").addEventListener("click", () => finishArea(true));
document.getElementById("undo").addEventListener("click", undo);
document.getElementById("clear").addEventListener("click", clearAll);
document.getElementById("copyBtn").addEventListener("click", copySelected);
document.getElementById("cutBtn").addEventListener("click", cutSelected);
document.getElementById("pasteBtn").addEventListener("click", pasteClipboard);
document.getElementById("deleteBtn").addEventListener("click", deleteSelected);
document.getElementById("groupBtn").addEventListener("click", groupSelection);
document.getElementById("makeWidgetBtn").addEventListener("click", makeWidgetSelection);
document.getElementById("enterWidgetBtn").addEventListener("click", () => enterComposite());
document.getElementById("exitWidgetBtn").addEventListener("click", exitComposite);
document.getElementById("ungroupBtn").addEventListener("click", ungroupSelection);

// Library: build the Widgets list, category switching, and toolkit tabs.
let libToolkit = "gtk4";
(function buildWidgetList() {
  const wrap = document.getElementById("libWidgets");
  wrap.innerHTML = "";
  const presetSec = document.createElement("div");
  presetSec.className = "lib-wsec collapsed";
  presetSec.innerHTML = '<div class="lib-wsec-head">Window presets <span class="pp-caret">▾</span></div><div class="lib-wsec-body"></div>';
  presetSec.querySelector(".lib-wsec-head").addEventListener("click", () => presetSec.classList.toggle("collapsed"));
  for (const [tk, label] of [["gtk4", "GTK Window preset"], ["kde", "KDE Window preset"]]) {
    const b = document.createElement("button");
    b.className = "lib-widget lib-preset";
    b.textContent = label;
    b.addEventListener("click", () => insertWindowPreset(tk));
    presetSec.querySelector(".lib-wsec-body").appendChild(b);
  }
  wrap.appendChild(presetSec);
  for (const cat of WIDGET_CATS) {
    const sec = document.createElement("div");
    // Keep the two most useful discovery groups open. The old all-expanded
    // list pushed Navigation's new chrome widgets below the visible panel.
    sec.className = "lib-wsec" + (["Sections", "Input", "Navigation"].includes(cat) ? "" : " collapsed");
    sec.dataset.category = cat.toLowerCase();
    const head = document.createElement("div");
    head.className = "lib-wsec-head";
    head.innerHTML = `${cat} <span class="pp-caret">▾</span>`;
    head.addEventListener("click", () => sec.classList.toggle("collapsed"));
    const body = document.createElement("div");
    body.className = "lib-wsec-body";
    for (const [kind, def] of Object.entries(WIDGETS)) {
      if (def.cat !== cat) continue;
      const b = document.createElement("button");
      b.className = "lib-widget";
      b.textContent = def.label;
      b.draggable = kind !== "window";
      b.title = kind === "window" ? "Use a Window preset above" : "Click to add · drag onto a Window or Section";
      b.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/x-pixelruller-widget", JSON.stringify({ kind, toolkit: libToolkit }));
      });
      b.addEventListener("click", () => kind === "window" ? insertWindowPreset(libToolkit) : insertWidget(kind, libToolkit));
      body.appendChild(b);
    }
    sec.appendChild(head);
    sec.appendChild(body);
    wrap.appendChild(sec);
  }
})();

document.querySelectorAll(".lib-cat").forEach(b => b.addEventListener("click", () => {
  setActive(".lib-cat", b);
  const icons = b.dataset.cat === "icons";
  document.getElementById("libGrid").hidden = !icons;
  document.getElementById("libWidgets").hidden = icons;
  document.getElementById("libToolkits").hidden = icons;
  const search = document.getElementById("libSearch");
  search.placeholder = icons ? "search icons…" : "search widgets…";
  search.value = "";
  search.dispatchEvent(new Event("input"));
}));

document.querySelectorAll(".lib-tk").forEach(b => b.addEventListener("click", () => {
  setActive(".lib-tk", b);
  libToolkit = b.dataset.tk;
}));

// Library panel: collapse toggle + search for both widgets and icons.
document.getElementById("libCollapse").addEventListener("click", () => {
  document.body.classList.toggle("lib-collapsed");
  document.getElementById("libCollapse").textContent =
    document.body.classList.contains("lib-collapsed") ? "⟨" : "⟩";
  resizeCanvas();
});
document.getElementById("libSearch").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const icons = document.querySelector('.lib-cat.active')?.dataset.cat === "icons";
  if (icons) {
    document.querySelectorAll("#libGrid .lib-item").forEach(b =>
      b.classList.toggle("hidden", q && !b.dataset.name.includes(q)));
    return;
  }
  document.querySelectorAll("#libWidgets .lib-wsec").forEach(sec => {
    const buttons = [...sec.querySelectorAll(".lib-widget")];
    let matches = 0;
    buttons.forEach(button => {
      const match = !q || button.textContent.toLowerCase().includes(q);
      button.hidden = !match;
      if (match) matches++;
    });
    sec.hidden = !!q && matches === 0;
    if (q && matches) sec.classList.remove("collapsed");
  });
});

const RESIZE_CURSOR = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

// Native Library → canvas drag/drop. The drop point chooses the smallest
// Window/Section beneath it; managed layouts then snap the widget into a slot.
canvas.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("application/x-pixelruller-widget") || e.dataTransfer.types.includes("text/plain")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes("application/x-pixelruller-widget") ? "copy" : "move";
    canvas.classList.add("library-drop");
    const r = canvas.getBoundingClientRect();
    const p = screenToImage(e.clientX - r.left, e.clientY - r.top);
    const moving = e.dataTransfer.types.includes("text/plain") ? byId(e.dataTransfer.getData("text/plain")) : null;
    state.dropHint = dropHintAt(p, moving);
    render();
  }
});
canvas.addEventListener("dragleave", () => { canvas.classList.remove("library-drop"); state.dropHint = null; render(); });
canvas.addEventListener("drop", (e) => {
  const raw = e.dataTransfer.getData("application/x-pixelruller-widget");
  const movingId = e.dataTransfer.getData("text/plain");
  const hint = state.dropHint;
  canvas.classList.remove("library-drop");
  state.dropHint = null;
  if (!raw && !movingId) return;
  e.preventDefault();
  if (movingId) {
    const moving = byId(movingId);
    const r = canvas.getBoundingClientRect();
    const exactHint = moving ? dropHintAt(screenToImage(e.clientX - r.left, e.clientY - r.top), moving) : null;
    if (!moving || isWindow(moving) || !exactHint) { render(); return; }
    moving.parent = exactHint.container.id; moving.slot = exactHint.slot - 0.5;
    moving.fixed = false; moving.z = nextZ();
    relayout(); selectOnly(state.shapes.indexOf(moving)); render();
    toast(`Moved into ${exactHint.container.name || exactHint.container.widget} · slot ${exactHint.slot}`);
    return;
  }
  let item;
  try { item = JSON.parse(raw); } catch { return; }
  if (!WIDGETS[item.kind] || item.kind === "window") return;
  const r = canvas.getBoundingClientRect();
  const at = screenToImage(e.clientX - r.left, e.clientY - r.top);
  insertWidget(item.kind, item.toolkit || libToolkit, at);
  const inserted = state.shapes[state.selected];
  if (hint && inserted) {
    inserted.parent = hint.container.id; inserted.slot = hint.slot - 0.5; inserted.fixed = false;
    relayout(); render();
    toast(`Added to ${hint.container.name || hint.container.widget} · slot ${hint.slot}`);
  }
});

canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (state.panning && state.panStart) {
    state.view.ox = state.panStart.ox + (sx - state.panStart.sx);
    state.view.oy = state.panStart.oy + (sy - state.panStart.sy);
    canvas.style.cursor = "grabbing";
  }
  state.mouse.sx = sx; state.mouse.sy = sy;
  const img = screenToImage(sx, sy);
  state.mouse.ix = img.x; state.mouse.iy = img.y;
  state.mouse.over = true;

  // Active drag: move / resize the selected element (create previews via render).
  if (state.drag) {
    const s = state.shapes[state.selected];
    if (state.drag.kind === "move") {
      const rawDx = img.x - state.drag.start.x, rawDy = img.y - state.drag.start.y;
      const snapped = snapMoveDelta(state.drag.indices, state.drag.origins, rawDx, rawDy);
      // Windows are fixed in place (stacked automatically) — never dragged.
      state.drag.moveIndices.forEach((i, n) => {
        const s = state.shapes[i];
        if (!isWindow(s)) { s.x = state.drag.moveOrigins[n].x + snapped.dx; s.y = state.drag.moveOrigins[n].y + snapped.dy; }
      });
      state.moveSnap = snapped.guides;
    } else if (state.drag.kind === "resize" && s) {
      resizeElement(s, state.drag.handle, img.x, img.y);
    } else if (state.drag.kind === "marquee") {
      state.drag.x1 = img.x; state.drag.y1 = img.y;
    }
    if (state.propOpen !== null) syncPropPanel(); // keep the panel numbers live
  } else if (state.mode === "select" && state.docMode === "canvas") {
    // Only a resize handle changes the cursor; otherwise it stays the pointer
    // (the grabber is now the explicit Move tool, not automatic on hover).
    const sel = state.selection.length === 1 ? state.shapes[state.selection[0]] : null;
    const h = handleAtScreen(sel, sx, sy);
    canvas.style.cursor = h ? RESIZE_CURSOR[h] : "default";
  }

  if (state.distInput) updateDistBox(); // keep the typed-distance box at the cursor
  render();
});

canvas.addEventListener("mouseleave", () => { state.mouse.over = false; render(); });

canvas.addEventListener("mousedown", (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  // Keep cursor image-coords current even if no mousemove preceded this press.
  state.mouse.sx = sx; state.mouse.sy = sy;
  const mi = screenToImage(sx, sy);
  state.mouse.ix = mi.x; state.mouse.iy = mi.y; state.mouse.over = true;
  // Camera gestures are consumed before hit-testing, so they can never select,
  // move, adopt or reorder a widget. Middle-drag is the global camera shortcut.
  if (e.button === 1 || (e.button === 0 && (state.spaceDown || state.mode === "camera"))) {
    state.panning = true;
    state.panStart = { sx, sy, ox: state.view.ox, oy: state.view.oy };
    e.preventDefault();
    return;
  }
  if (e.button === 2) {
    if (state.docMode === "canvas") { // right-click opens element properties
      const hit = hitTest(screenToImage(sx, sy));
      if (hit !== null && isElement(state.shapes[hit])) {
        selectOnly(hit);
        openProps(hit, e.clientX, e.clientY);
        render();
      }
    } else if (state.building && state.building.pts.length) {
      undo(); // screenshot mode: remove the last point while drawing an area
    }
    e.preventDefault();
    return;
  }
  if (e.button === 0 && state.ready) {
    // Ctrl/Cmd+Click opens the element properties panel (any mode).
    if (e.ctrlKey || e.metaKey) {
      const hit = hitTest(screenToImage(sx, sy));
      if (hit !== null && isElement(state.shapes[hit])) {
        selectOnly(hit);
        openProps(hit, e.clientX, e.clientY);
        render();
      }
      return;
    }
    if (state.mode === "rect" || state.mode === "ellipse") {
      state.drag = { kind: "create", type: state.mode, x0: state.mouse.ix, y0: state.mouse.iy };
    } else if (state.mode === "select" || state.mode === "move") {
      // Resize handles belong to Select. Move has one job: moving/reparenting.
      if (state.mode === "select" && state.selection.length === 1) {
        const h = handleAtScreen(state.shapes[state.selection[0]], sx, sy);
        if (h) { state.drag = { kind: "resize", handle: h }; return; }
      }
      const p = screenToImage(sx, sy);
      const hit = hitTest(p);
      if (state.mode === "select" && hit !== null && !e.shiftKey &&
          ((state.shapes[hit].action && state.shapes[hit].action !== "none" && state.shapes[hit].target) ||
           interactionTargets(state.shapes[hit]).length)) {
        selectOnly(hit);
        toggleInteractionTarget(state.shapes[hit]);
        return;
      }
      // Tabs are editable directly on the design surface: a plain click selects
      // the strip and makes the tab under the pointer active. Only Move may
      // create a following movement drag.
      if (hit !== null && state.shapes[hit]?.widget === "tabs" && !e.shiftKey) {
        const tabs = state.shapes[hit];
        const count = Math.max(1, Math.min(12, tabs.count != null ? tabs.count : 3));
        tabs.active = Math.max(0, Math.min(count - 1, Math.floor((p.x - tabs.x) / (tabs.w / count))));
        selectOnly(hit);
        syncPropPanel();
      }
      if (state.mode === "select" && hit === null) {
        if (!e.shiftKey) clearSelection();
        state.drag = { kind: "marquee", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      } else if (state.mode === "select" && e.shiftKey) {
        toggleInSelection(hit);
      } else if (state.mode === "select") {
        // Selection is deliberately non-moving. A click can change selection,
        // but no drag state is created and parent/slot order cannot change.
        if (hit !== null) selectOnly(hit);
      } else if (hit !== null) {
        if (!state.selection.includes(hit)) selectOnly(hit);
        else { state.selected = hit; syncInputsFromSelection(); }
        const indices = state.selection.filter(i => isElement(state.shapes[i]) && !isWindow(state.shapes[i]));
        const moveSet = new Set(indices);
        for (const i of indices) if (isComposite(state.shapes[i]))
          for (const k of descendantsOf(state.shapes[i])) moveSet.add(state.shapes.indexOf(k));
        const moveIndices = [...moveSet];
        state.drag = {
          kind: "move", start: { x: p.x, y: p.y }, indices,
          origins: indices.map(i => ({ x: state.shapes[i].x, y: state.shapes[i].y })),
          moveIndices, moveOrigins: moveIndices.map(i => ({ x: state.shapes[i].x, y: state.shapes[i].y })),
        };
      }
      render();
    } else if (state.mode === "point") commitPoint();
    else addAreaVertex();
  }
});

window.addEventListener("mouseup", () => {
  if (state.drag) {
    if (state.drag.kind === "create") commitDraft();
    else if (state.drag.kind === "marquee") { finalizeMarquee(state.drag); state.drag = null; render(); }
    else {
      // Dropping a move re-parents each element into the container under it.
      if (state.drag.kind === "move") {
        const adopted = [];
        for (const i of state.selection) {
          const s = state.shapes[i], c = adoptShape(s);
          // Select-drag means layout parenting/reordering. If an element had
          // previously been manually fixed, rejoining an active container
          // must clear Fixed or arrangeInto() will correctly ignore it.
          if (c && c.layout && c.layout !== "none") s.fixed = false;
          if (c) adopted.push(c);
        }
        if (adopted.length) {
          const c = adopted[0];
          toast(`Child of ${c.name || c.widget} · ${c.layout || "manual"} layout`);
        }
      }
      state.drag = null;
      state.moveSnap = null;
    }
    // Dropping ends the gesture: snap managed containers' children into slots.
    relayout();
    if (state.propOpen !== null) syncPropPanel();
    render();
  }
  state.panning = false; state.panStart = null;
  canvas.style.cursor = cursorForMode();
});

// Select every element whose bbox intersects the marquee rectangle.
function finalizeMarquee(m) {
  const x0 = Math.min(m.x0, m.x1), y0 = Math.min(m.y0, m.y1);
  const x1 = Math.max(m.x0, m.x1), y1 = Math.max(m.y0, m.y1);
  if (x1 - x0 < 3 && y1 - y0 < 3) return; // a click, not a drag
  const hits = [];
  state.shapes.forEach((s, i) => {
    if (!isElement(s)) return;
    const bb = shapeBBox(s);
    // Skip a background container that fully contains the marquee (e.g. the Window).
    if (bb.x <= x0 && bb.y <= y0 && bb.x + bb.w >= x1 && bb.y + bb.h >= y1) return;
    if (bb.x < x1 && bb.x + bb.w > x0 && bb.y < y1 && bb.y + bb.h > y0) hits.push(i);
  });
  state.selection = hits;
  state.selected = hits.length ? hits[hits.length - 1] : null;
  if (state.selected !== null) syncInputsFromSelection();
  syncPropsToSelection();
}

canvas.addEventListener("dblclick", (e) => {
  if (state.building) { finishArea(false); return; }
  if (state.docMode !== "canvas") return;
  const r = canvas.getBoundingClientRect();
  const hit = hitTest(screenToImage(e.clientX - r.left, e.clientY - r.top));
  const s = hit !== null ? state.shapes[hit] : null;
  if (isComposite(s)) enterComposite(s);
});

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const p = screenToImage(e.clientX - r.left, e.clientY - r.top);
  const scroller = state.shapes.filter(s => isContainer(s) && s.overflow === "scroll" && s.interactionEnabled && responsiveVisible(s) &&
    p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (scroller && (scroller.scrollMaxX > 0 || scroller.scrollMaxY > 0)) {
    if (e.shiftKey && scroller.scrollMaxX > 0)
      scroller.scrollX = Math.max(0, Math.min(scroller.scrollMaxX, (Number(scroller.scrollX) || 0) + e.deltaY / state.view.scale));
    else scroller.scrollY = Math.max(0, Math.min(scroller.scrollMaxY, (Number(scroller.scrollY) || 0) + e.deltaY / state.view.scale));
    relayout(); render();
    return;
  }
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "u") {
    e.preventDefault();
    setCommandFocus(!document.body.classList.contains("command-focus"));
    return;
  }
  if (e.target.tagName === "INPUT") return;
  // Typed distance: digits while drawing an area build a length; Enter applies it.
  if (state.building && /^[0-9.]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    state.distInput += e.key;
    updateDistBox();
    e.preventDefault();
    return;
  }
  if (state.distInput) {
    if (e.key === "Enter") { e.preventDefault(); commitTypedDistance(); return; }
    if (e.key === "Backspace") { e.preventDefault(); state.distInput = state.distInput.slice(0, -1); updateDistBox(); return; }
    if (e.key === "Escape") { e.preventDefault(); state.distInput = ""; updateDistBox(); return; }
  }
  if (e.code === "Space") { state.spaceDown = true; e.preventDefault(); }
  else if (e.key === "Enter") finishArea(true);
  else if (e.key === "Escape") { state.building = null; if (state.editComposite) exitComposite(); else { clearSelection(); closeProps(); render(); } }
  else if (e.key === "Delete" || e.key === "Backspace") { if (state.selected !== null) { e.preventDefault(); deleteSelected(); } }
  else if (e.key.toLowerCase() === "s" && !(e.ctrlKey || e.metaKey)) { document.querySelector('.mode[data-mode="select"]').click(); }
  else if (e.key.toLowerCase() === "m" && !(e.ctrlKey || e.metaKey) && state.docMode === "canvas") { document.querySelector('.mode[data-mode="move"]').click(); }
  else if (e.key.toLowerCase() === "c" && !(e.ctrlKey || e.metaKey) && state.docMode === "canvas") { document.querySelector('.mode[data-mode="camera"]').click(); }
  else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
  else if (e.key.toLowerCase() === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  else if (e.key.toLowerCase() === "j" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); exportJson(); }
  else if (e.key.toLowerCase() === "o" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openFile(); }
  else if (e.key.toLowerCase() === "c" && (e.ctrlKey || e.metaKey)) { if (state.selected !== null) { e.preventDefault(); copySelected(); } }
  else if (e.key.toLowerCase() === "x" && (e.ctrlKey || e.metaKey)) { if (state.selected !== null) { e.preventDefault(); cutSelected(); } }
  else if (e.key.toLowerCase() === "v" && (e.ctrlKey || e.metaKey)) { if (clipboard) { e.preventDefault(); pasteClipboard(); } }
  else if (e.key.toLowerCase() === "d" && (e.ctrlKey || e.metaKey)) { if (state.selected !== null) { e.preventDefault(); duplicateSelected(); } }
  else if (e.key.toLowerCase() === "g" && (e.ctrlKey || e.metaKey) && e.shiftKey) { e.preventDefault(); ungroupSelection(); }
  else if (e.key.toLowerCase() === "g" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); groupSelection(); }
  else if (e.key.toLowerCase() === "g") { document.getElementById("gridToggle").click(); }
  else if (e.key.toLowerCase() === "f") { fitToView(); render(); }
  else if (e.key.toLowerCase() === "p" && state.docMode === "screenshot") { document.querySelector('.mode[data-mode="point"]').click(); }
  else if (e.key.toLowerCase() === "a" && state.docMode === "screenshot") { document.querySelector('.mode[data-mode="area"]').click(); }
  else if (e.key.toLowerCase() === "r" && state.docMode === "canvas") { document.querySelector('.mode[data-mode="rect"]').click(); }
  else if (e.key.toLowerCase() === "e" && state.docMode === "canvas") { document.querySelector('.mode[data-mode="ellipse"]').click(); }
});

window.addEventListener("keyup", (e) => { if (e.code === "Space") state.spaceDown = false; });

window.addEventListener("resize", resizeCanvas);

let remoteCommandTimer = null;
async function pollRemoteCommands() {
  clearTimeout(remoteCommandTimer);
  try {
    // Drain the whole queue each tick so batched command streams run at
    // execution speed instead of one command per poll interval.
    for (let drained = 0; drained < 500; drained++) {
      const response = await fetch("/api/commands/next", { cache: "no-store" });
      if (response.status !== 200) break;
      const item = await response.json();
      const result = runCommand(item.command);
      await fetch("/api/commands/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, ...result }),
      });
    }
  } catch (_) {
    // The editor may outlive a restarted local server; polling resumes quietly.
  }
  remoteCommandTimer = setTimeout(pollRemoteCommands, 150);
}

// ----- Boot -------------------------------------------------------------
hintEl.innerHTML =
  "Point mode: click to read pixel coordinates. Area mode: click to chain measured lines.<br>" +
  "Scroll to zoom · Camera/Space/middle-drag to pan · Enter to finish · G grid · F fit";

resizeCanvas();
applyModeUI(); // default screenshot-mode toolbar until a document is started
loadLibrary();  // fetch the icon list (panel appears in canvas mode)

const params = new URLSearchParams(location.search);
if (params.get("design")) {
  hideStart();
  loadDesignFromUrl(params.get("design"));
} else if (params.get("mode") === "grid") {
  // Command shortcut: capture straight into the pixel-counting grid.
  state.grid.on = true;
  state.grid.spacing = 25;
  document.getElementById("gridSpacing").value = 25;
  hideStart();
  window.addEventListener("load", capture);
} else {
  // Otherwise begin by choosing a start mode (screenshot / blank canvas / load).
  showStart();
}
if (params.has("selftest")) {
  window.__layoutSelfTestResult = runLayoutSelfTests();
  document.body.dataset.layoutTests = window.__layoutSelfTestResult.ok ? "pass" : "fail";
}
pollRemoteCommands();
