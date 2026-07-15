"use strict";

// ----- State ------------------------------------------------------------
const state = {
  ready: false,         // a document exists (screenshot captured or blank canvas created)
  docMode: "screenshot", // "screenshot" (measuring) | "canvas" (designing)
  background: null,     // HTMLImageElement screenshot, or null for a blank canvas
  bgColor: "#ffffff",   // fill color when there is no background image
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
  const head = c.widget === "window" ? Math.min(44, c.h * 0.18) : c.widget === "section" ? 22 : 0;
  return {
    x: c.x + P.l, y: c.y + P.t + head,
    w: Math.max(0, c.w - P.l - P.r), h: Math.max(0, c.h - P.t - P.b - head),
  };
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
    const ah = s.alignH || "center", av = s.alignV || "middle";
    const pad = 6 * tf.scale;
    g.fillStyle = s.textColor || "#ffffff";
    g.font = `${Math.max(7, (s.fontSize || 14) * tf.scale)}px system-ui, sans-serif`;
    g.textAlign = ah;
    g.textBaseline = av === "middle" ? "middle" : av;
    const tx = ah === "left" ? p.x + pad : ah === "right" ? p.x + w - pad : p.x + w / 2;
    const ty = av === "top" ? p.y + pad : av === "bottom" ? p.y + h - pad : p.y + h / 2;
    g.fillText(s.text, tx, ty);
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
  const alignedText = (str, color, defAlign, bounds = null, defAlignV = "middle") => {
    const b = bounds || { x: p.x, y: p.y, w, h };
    const ah = s.alignH || defAlign || "center", av = s.alignV || defAlignV;
    const pad = 8 * tf.scale;
    g.fillStyle = color || s.textColor || "#111827";
    g.font = `${fs}px system-ui, sans-serif`;
    g.textAlign = ah;
    g.textBaseline = av === "middle" ? "middle" : av;
    const tx = ah === "left" ? b.x + pad : ah === "right" ? b.x + b.w - pad : b.x + b.w / 2;
    const ty = av === "top" ? b.y + pad : av === "bottom" ? b.y + b.h - pad : b.y + b.h / 2;
    g.fillText(str, tx, ty);
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
    const hasText = pos !== "only" && !!str;
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
      g.font = `${fs}px system-ui, sans-serif`; g.textAlign = align; g.textBaseline = "middle";
      g.fillText(str, tx, ty);
    }
  };
  const box = (x, y, bw, bh, r, fill, stroke) => {
    g.beginPath(); roundRect(g, x, y, bw, bh, Math.min(r * tf.scale, bw / 2, bh / 2));
    if (fill && fill !== "none") { g.fillStyle = fill; g.fill(); }
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
        g.strokeStyle = "#ffffff"; g.lineWidth = Math.max(1.5, 2 * tf.scale); g.lineCap = "round";
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
      g.fillStyle = "#ffffff"; g.fill();
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
    case "window": {
      const tk = s.toolkit === "kde" ? "kde" : "gtk4";
      box(p.x, p.y, w, h, s.radius || 0, s.fill || "#ffffff", s.stroke);
      // When the window owns an editable Title bar child, that widget draws the
      // whole bar (title, buttons, tabs…) — skip the painted fallback chrome.
      if (childrenOf(s).some(k => k.widget === "titlebar")) break;
      const bar = Math.min(44 * tf.scale, h * 0.18);
      // KDE: a real separate titlebar (solid strip + separator line, Breeze
      // grey by default, own `barFill` property); GTK: integrated headerbar.
      if (tk === "kde") {
        g.save();
        g.beginPath(); roundRect(g, p.x, p.y, w, h, Math.min((s.radius || 0) * tf.scale, w / 2, h / 2));
        g.clip();
        g.fillStyle = s.barFill || "#dae0e5";
        g.fillRect(p.x, p.y, w, bar);
        g.strokeStyle = strokeColor(s, s.stroke || "#bdc3c7");
        g.lineWidth = Math.max(1, tf.scale);
        g.beginPath(); g.moveTo(p.x, p.y + bar); g.lineTo(p.x + w, p.y + bar); g.stroke();
        g.restore();
      }
      const tc = s.textColor || "#111827";
      const bcy = p.y + bar / 2;
      alignedText(s.text || "Window", tc, tk === "gtk4" ? "center" : "left",
        { x: p.x + 4 * tf.scale, y: p.y, w: Math.max(1, w - 8 * tf.scale), h: bar });
      // Controls: hamburger + 3 window buttons, on buttonSide (default right).
      const r = Math.max(3, Math.min(bar * 0.16, 9 * tf.scale));
      const cd = r * 2, sp = r * 0.8, hbW = r * 2.2, pad = 14 * tf.scale;
      const clusterW = hbW + sp * 3 + 3 * cd + 2 * sp;
      const x0 = s.buttonSide === "left" ? p.x + pad : p.x + w - pad - clusterW;
      g.strokeStyle = tc; g.lineWidth = Math.max(1.5, 2 * tf.scale); g.lineCap = "round";
      for (const dy of [-r * 0.55, 0, r * 0.55]) { g.beginPath(); g.moveTo(x0, bcy + dy); g.lineTo(x0 + hbW, bcy + dy); g.stroke(); }
      let cxx = x0 + hbW + sp * 3 + r;
      for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(cxx, bcy, r, 0, Math.PI * 2); g.fillStyle = tc; g.fill(); cxx += cd + sp; }
      break;
    }
    case "section":
      g.save(); g.setLineDash([5, 4]);
      box(p.x, p.y, w, h, s.radius || 0, s.fill, s.stroke);
      g.restore();
      alignedText(s.text || "Section", s.textColor || "#6b7280", "left", null, "top");
      break;
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
      g.fillStyle = s.textColor || "#111827"; g.font = `${Math.max(6, fs * 0.72)}px system-ui, sans-serif`;
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
      g.fillStyle = s.textColor || "#111827"; g.font = `${fs}px system-ui, sans-serif`;
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
      g.font = `${fs}px system-ui, sans-serif`; g.textBaseline = "middle"; g.textAlign = "left";
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
      g.font = `${fs}px system-ui, sans-serif`; g.textBaseline = "middle";
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
          const col = ctl === "close" ? "#ff5f57" : ctl === "max" ? "#28c840" : "#febc2e";
          g.beginPath(); g.arc(bxc, byc, r, 0, Math.PI * 2); g.fillStyle = col; g.fill();
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
  const pad = isElement(s) ? 0 : 8;
  const a = toScreen(tf, bb.x, bb.y), b = toScreen(tf, bb.x + bb.w, bb.y + bb.h);
  g.save();
  g.strokeStyle = "#ffffff";
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
    toast("Captured " + state.W + "×" + state.H);
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
  state.editComposite = null;
  clearSelection();
  state.building = null;
  state.mode = "select";
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
    fontSize: 14, textColor: "#111827", ...def.defaults, ...overrides,
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
  select.innerHTML = '<option value="">None</option>';
  for (const ic of libraryIcons) {
    const option = document.createElement("option");
    option.value = ic.src; option.textContent = ic.name;
    select.appendChild(option);
  }
  select.value = libraryIcons.some(ic => ic.src === current) ? current : "";
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
function hugDimensions(s) {
  const def = s.type === "widget" ? WIDGETS[s.widget] : null;
  const metric = def && (def[s.toolkit] || def.gtk4);
  const P = side4(s.padding);
  const fs = s.fontSize || 14;
  const textW = s.text ? Math.ceil(String(s.text).length * fs * 0.62) : 0;
  const w = Math.max(metric?.w || 24, textW + P.l + P.r + 16);
  const h = Math.max(metric?.h || 18, fs * 1.45 + P.t + P.b);
  return { w: bounded(w, s.minW, s.maxW), h: bounded(h, s.minH, s.maxH) };
}

function prepareLayoutSize(s) {
  const hug = hugDimensions(s);
  if (s.sizeModeX === "hug") s.w = hug.w;
  if (s.sizeModeY === "hug") s.h = hug.h;
  s.w = bounded(s.w, s.minW, s.maxW);
  s.h = bounded(s.h, s.minH, s.maxH);
}

// Reposition direct children per layout, sizing rules, margins and slots.
// fixed children remain absolute. Fill/grow and percentage sizing operate on
// the layout's main axis; wrap starts a new row/column; table honors spans.
function arrangeInto(c) {
  const P = side4(c.padding, 12), gap = c.gap != null ? c.gap : 12;
  const align = c.align || "left", layout = c.layout || "vertical";
  // A window that owns an editable title bar reserves no painted chrome — the
  // titlebar child sits at slot 0 and provides the bar itself.
  const hasTitlebar = c.widget === "window" && childrenOf(c).some(k => k.widget === "titlebar");
  const headOffset = (c.widget === "window" && !hasTitlebar) ? Math.min(44, c.h * 0.18)
    : c.widget === "section" ? 22 : 0;
  const top = c.y + P.t + headOffset, left = c.x + P.l;
  const innerW = Math.max(1, c.w - P.l - P.r);
  const innerH = Math.max(1, c.h - P.t - P.b - headOffset);
  const kids = childrenOf(c).filter(s => !s.fixed);
  if (!kids.length) return 0;
  kids.sort((a, b) => slotOf(a) - slotOf(b) || a.y - b.y || a.x - b.x);
  kids.forEach((k, i) => { k.slot = i; prepareLayoutSize(k); });

  const alignX = (k, M, width = innerW) => align === "center" ? left + (width - k.w) / 2
    : align === "right" ? left + width - k.w - M.r : left + M.l;
  const alignY = (k, M, height = innerH) => align === "center" ? top + (height - k.h) / 2
    : align === "right" ? top + height - k.h - M.b : top + M.t;

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
    let x = left, y = top, lineH = 0;
    for (const k of kids) {
      const M = side4(k.margin), totalW = M.l + k.w + M.r;
      if (c.wrap && x > left && x + totalW > left + innerW) { x = left; y += lineH + gap; lineH = 0; }
      if (k.sizeModeY === "fill" && !c.wrap) k.h = bounded(innerH - M.t - M.b, k.minH, k.maxH);
      else if (k.sizeModeY === "percent") k.h = bounded((innerH - M.t - M.b) * percentage(k, "y") / 100, k.minH, k.maxH);
      k.x = Math.round(x + M.l); k.y = Math.round(c.wrap ? y + M.t : alignY(k, M));
      x += totalW + gap; lineH = Math.max(lineH, M.t + k.h + M.b);
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
      p.k.x = Math.round(p.k.sizeModeX === "fill" || align === "left" ? cellX + p.M.l
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
    let x = left, y = top, lineW = 0;
    for (const k of kids) {
      const M = side4(k.margin), totalH = M.t + k.h + M.b;
      if (c.wrap && y > top && y + totalH > top + innerH) { y = top; x += lineW + gap; lineW = 0; }
      if (k.sizeModeX === "fill" && !c.wrap) k.w = bounded(innerW - M.l - M.r, k.minW, k.maxW);
      else if (k.sizeModeX === "percent") k.w = bounded((innerW - M.l - M.r) * percentage(k, "x") / 100, k.minW, k.maxW);
      k.x = Math.round(c.wrap ? x + M.l : alignX(k, M)); k.y = Math.round(y + M.t);
      y += totalH + gap; lineW = Math.max(lineW, M.l + k.w + M.r);
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
  for (const c of cs) arrangeInto(c);
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
  section:  { label: "Section",  cat: "Sections", gtk4: { w: 240, h: 160, radius: 8 }, kde: { w: 240, h: 160, radius: 4 },
              defaults: { text: "Section", fill: "none", stroke: "#9aa1ac", strokeWidth: 1, textColor: "#6b7280" } },
  // ----- Input -----
  button:   { label: "Button",   cat: "Input", gtk4: { w: 120, h: 34, radius: 8 }, kde: { w: 110, h: 30, radius: 4 },
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
              defaults: { value: 30, fill: "#dfe3e8", thumbFill: "#7b8490", stroke: "#c9ced6", strokeWidth: 0 } },
  // ----- Navigation / window chrome -----
  menubar:  { label: "Menubar",  cat: "Navigation", gtk4: { w: 360, h: 32, radius: 0 }, kde: { w: 360, h: 26, radius: 0 },
              defaults: { text: "", fill: "#f1f3f5", stroke: "#c9ced6", strokeWidth: 1, textColor: "#111827", layout: "horizontal", align: "left", gap: 4, padding: { t: 2, r: 6, b: 2, l: 6 } } },
  toolbar:  { label: "Toolbar",  cat: "Navigation", gtk4: { w: 360, h: 42, radius: 0 }, kde: { w: 360, h: 36, radius: 0 },
              defaults: { count: 5, fill: "#f1f3f5", stroke: "#c9ced6", strokeWidth: 1, textColor: "#59636e", layout: "horizontal", align: "left", gap: 6, padding: { t: 4, r: 8, b: 4, l: 8 } } },
  menuitem: { label: "Menu item", cat: "Navigation", gtk4: { w: 52, h: 28, radius: 4 }, kde: { w: 48, h: 22, radius: 2 },
              defaults: { text: "Menu", fill: "none", stroke: "#000000", strokeWidth: 0, textColor: "#111827", iconSize: 16, iconPosition: "left", iconGap: 5 } },
  toolbutton:{ label: "Tool button", cat: "Navigation", gtk4: { w: 30, h: 30, radius: 6 }, kde: { w: 28, h: 26, radius: 3 },
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
  "opacity", "fontSize", "textColor", "alignH", "alignV", "margin", "padding", "gap",
  "sizeModeX", "sizeModeY", "widthPercent", "heightPercent", "grow",
  "minW", "maxW", "minH", "maxH", "colSpan", "rowSpan",
  "wrap", "cols", "overflow"];
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

const CMD_HELP =
  'add <widget|rect|ellipse> [into <container>] · add window empty [gtk4|kde] [w] [h] [name] · ' +
  'add window copy <source> [w] [h] [name] · set <el> <prop>[.<side>] <value> · ' +
  'move <el> <dx> <dy> · move <el> into <container> [<slot>] · resize <el> <w> <h> · ' +
  'del <el> · copy <el> [n] · rename <el> <name> · select <el> · arrange <container> · ' +
  'make-widget [name] · enter <composite> · exit · ungroup <composite|section> · ' +
  'theme <GTK light|GTK dark|KDE light|KDE dark> · list · help';

function runCommand(input) {
  const res = execCommand(input);
  cmdLog.push({ cmd: input, ok: res.ok, msg: res.msg });
  return res;
}

function execCommand(input) {
  const t = tokenize(input);
  if (!t.length) return { ok: false, msg: "empty command" };
  const verb = t[0].toLowerCase();
  const done = (msg) => {
    relayout();
    if (state.propOpen !== null) syncPropPanel();
    render();
    return { ok: true, msg };
  };
  const fail = (msg) => ({ ok: false, msg });
  try {
    switch (verb) {
      case "help":
        return { ok: true, msg: CMD_HELP };

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
        const intoIdx = t.indexOf("into");
        const container = intoIdx > 0 ? findShape(t[intoIdx + 1]) : null;
        if (intoIdx > 0 && !container) return fail(`no container "${t[intoIdx + 1]}"`);
        let el;
        if (kind === "rect" || kind === "ellipse") {
          const nums = t.slice(2, intoIdx > 0 ? intoIdx : undefined).map(Number);
          const [x = 100, y = 100, w = 160, h = 60] = nums;
          el = { id: nextId(), parent: null, type: kind, x, y, w, h,
            name: nextName(kind), text: "", filled: true, fixed: false, z: nextZ(),
            fontSize: 14, alignH: "center", alignV: "middle", textColor: "#ffffff",
            ...styleFromToolbar() };
          state.shapes.push(el);
          adoptShape(el);
        } else if (WIDGETS[kind]) {
          insertWidget(kind, libToolkit);
          el = state.shapes[state.shapes.length - 1];
        } else {
          return fail(`unknown element "${kind}" — rect, ellipse, ${Object.keys(WIDGETS).join(", ")}`);
        }
        if (container && isContainer(container) && !isWindow(el)) { el.parent = container.id; el.slot = 9999; }
        selectOnly(state.shapes.indexOf(el));
        return done(`added ${el.name}${container ? " into " + (container.name || container.id) : ""}`);
      }

      case "set": {
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1]}"`);
        const path = (t[2] || "").split(".");
        if (!path[0] || t[3] === undefined) return fail("set <el> <prop> <value>");
        const val = parseVal(t.slice(3).join(" "));
        if (path.length === 2) {
          if (path[0] === "margin" || path[0] === "padding") s[path[0]] = side4(s[path[0]]);
          if (typeof s[path[0]] !== "object" || s[path[0]] == null) s[path[0]] = {};
          s[path[0]][path[1]] = val;
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
        const s = findShape(t[1]);
        if (!s) return fail(`no element "${t[1]}"`);
        selectOnly(state.shapes.indexOf(s));
        render();
        return { ok: true, msg: `selected ${s.name || s.id}` };
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

      case "list": {
        const lines = [];
        const walk = (c, d) => {
          for (const k of childrenOf(c).sort((a, b) => slotOf(a) - slotOf(b))) {
            lines.push("  ".repeat(d) + `${k.name || k.id} [${k.widget || k.type}]${k.fixed ? " 📌" : ""}`);
            if (isContainer(k)) walk(k, d + 1);
          }
        };
        for (const w of state.shapes.filter(isWindow)) {
          lines.push(`${w.name || w.id} [window]`);
          walk(w, 1);
        }
        return { ok: true, msg: lines.join("\n") || "empty design" };
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
  const textAlign = defaultTextAlign(s);
  PP("AlignH").value = s.alignH || textAlign.h;
  PP("AlignV").value = s.alignV || textAlign.v;
  PP("TextColor").value = s.textColor || "#ffffff";
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
  document.getElementById("ppIconSec").hidden = !iconCapable;
  if (iconCapable) {
    refreshWidgetIconOptions();
    PP("Icon").value = s.icon || "";
    const iconSize = Math.max(8, Number(s.iconSize) || (s.widget === "menuitem" || s.widget === "textbox" ? 16 : 18));
    PP("IconSize").value = iconSize; PP("IconSizev").textContent = iconSize;
    PP("IconPosition").value = s.iconPosition || (s.widget === "toolbutton" ? "only" : "left");
    PP("IconGap").value = Math.max(0, Number(s.iconGap) || 6);
  }
  // Layout section only applies to containers (Section / Window).
  const container = isContainer(s);
  document.getElementById("ppLayoutSec").hidden = !container;
  if (container) {
    PP("Layout").value = s.layout || "vertical";
    PP("Align").value = s.align || "left";
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
  s.alignH = PP("AlignH").value;
  s.alignV = PP("AlignV").value;
  s.textColor = PP("TextColor").value;
  if (s.type === "widget" && ["button", "toolbutton", "menuitem", "textbox"].includes(s.widget)) {
    s.icon = PP("Icon").value || null;
    s.iconSize = Math.max(8, Number(PP("IconSize").value) || 18);
    s.iconPosition = PP("IconPosition").value || "left";
    s.iconGap = Math.max(0, Number(PP("IconGap").value) || 0);
    PP("IconSizev").textContent = s.iconSize;
    if (s.icon) getIconImage(s.icon);
  }
  if (isContainer(s)) {
    s.layout = PP("Layout").value; s.align = PP("Align").value; s.gap = n0("Gap");
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
      alignH: s.alignH || null, alignV: s.alignV || null,
    };
    if (s.variantOf) out.variantOf = s.variantOf;
    if (s.variantLabel) out.variantLabel = s.variantLabel;
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
    if (s.align) out.align = s.align;
    if (s.gap != null) out.gap = s.gap;
    if (s.cols != null) out.cols = s.cols;
    if (s.wrap != null) out.wrap = !!s.wrap;
    if (s.overflow) out.overflow = s.overflow;
    if (s.scrollX != null) out.scrollX = s.scrollX;
    if (s.scrollY != null) out.scrollY = s.scrollY;
    if (s.bindScroll != null) out.bindScroll = !!s.bindScroll;
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
      alignV: s.alignV || "middle", textColor: s.textColor || "#ffffff",
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
  newCanvas(w, h); // blank canvas of the right size (clears shapes)
  const loadSizing = (s) => ({
    sizeModeX: s.sizeModeX || "fixed", sizeModeY: s.sizeModeY || "fixed", grow: Number(s.grow) || 0,
    widthPercent: s.widthPercent != null ? Math.max(0, Math.min(100, Number(s.widthPercent))) : 100,
    heightPercent: s.heightPercent != null ? Math.max(0, Math.min(100, Number(s.heightPercent))) : 100,
    minW: Number(s.minW) || 0, maxW: Number(s.maxW) || 0,
    minH: Number(s.minH) || 0, maxH: Number(s.maxH) || 0,
    colSpan: Math.max(1, Number(s.colSpan) || 1), rowSpan: Math.max(1, Number(s.rowSpan) || 1),
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
        alignH: s.alignH || null, alignV: s.alignV || null,
        checked: s.checked, on: s.on, value: s.value, count: s.count,
        active: s.active, lines: s.lines, controls: s.controls,
        buttonSide: s.buttonSide, barFill: s.barFill, layout: s.layout, align: s.align,
        gap: s.gap, cols: s.cols, wrap: !!s.wrap, overflow: s.overflow || "visible",
        scrollX: Number(s.scrollX) || 0, scrollY: Number(s.scrollY) || 0,
        bindScroll: !!s.bindScroll, strokeOpacity: s.strokeOpacity,
        icon: s.icon || null, iconSize: Number(s.iconSize) || undefined,
        iconPosition: s.iconPosition || null, iconGap: Number(s.iconGap) || 0,
        frame: s.frame ? JSON.parse(JSON.stringify(s.frame)) : undefined,
        resizeMode: s.resizeMode || "reflow" };
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
        alignV: s.alignV || "middle", textColor: s.textColor || "#ffffff",
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
  a.push(`size-x="${xmlEsc(s.sizeModeX || "fixed")}" size-y="${xmlEsc(s.sizeModeY || "fixed")}"`);
  if (s.sizeModeX === "percent") a.push(`width-percent="${s.widthPercent != null ? s.widthPercent : 100}"`);
  if (s.sizeModeY === "percent") a.push(`height-percent="${s.heightPercent != null ? s.heightPercent : 100}"`);
  if (s.grow) a.push(`grow="${s.grow}"`);
  if (s.minW) a.push(`min-w="${s.minW}"`); if (s.maxW) a.push(`max-w="${s.maxW}"`);
  if (s.minH) a.push(`min-h="${s.minH}"`); if (s.maxH) a.push(`max-h="${s.maxH}"`);
  if (s.margin) { const m = side4(s.margin); a.push(`margin="${m.t},${m.r},${m.b},${m.l}"`); }
  if (s.padding) { const p = side4(s.padding); a.push(`padding="${p.t},${p.r},${p.b},${p.l}"`); }
  if (s.layout) a.push(`layout="${xmlEsc(s.layout)}"`);
  if (s.align) a.push(`align="${xmlEsc(s.align)}"`);
  if (s.gap != null) a.push(`gap="${s.gap}"`);
  if (s.wrap) a.push(`wrap="true"`);
  if (s.cols) a.push(`columns="${s.cols}"`);
  if (s.overflow) a.push(`overflow="${xmlEsc(s.overflow)}"`);
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
const cssAlign = (v) => v === "center" ? "center" : v === "right" ? "flex-end" : "flex-start";
const cssTextAlign = (v) => ["left", "right", "center"].includes(v) ? v : "left";
const cssId = (s) => htmlEsc(s.id || s.name || s.widget || s.type);

function htmlContentBox(s) {
  const P = side4(s.padding, 12);
  const hasTitlebar = s.widget === "window" && childrenOf(s).some(k => k.widget === "titlebar");
  const head = s.widget === "window" && !hasTitlebar ? Math.min(44, s.h * 0.18)
    : s.widget === "section" ? 22 : 0;
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
  if (s.maxW) out.push(`max-width:${cssPx(s.maxW)}`);
  if (s.maxH) out.push(`max-height:${cssPx(s.maxH)}`);
  if (indicator) out.push("background:transparent", `--sr-accent:${look.fill || "#4a9eff"}`, `accent-color:${look.fill || "#4a9eff"}`);
  else if (look.fill && look.fill !== "none") out.push(`background:${look.fill}`); else out.push("background:transparent");
  const sw = Math.max(0, Number(look.strokeWidth) || 0);
  out.push(`border:${indicator ? 0 : sw}px solid ${look.stroke || "transparent"}`, `border-radius:${cssPx(look.radius || 0)}`);
  if (!isContainer(s)) out.push(`padding:${cssSides(s.padding)}`);
  return out.join(";");
}

function htmlContainerStyle(s) {
  const layout = s.layout || "vertical", P = side4(s.padding, 12);
  const out = ["position:relative", "flex:1 1 auto", "min-width:0", "min-height:0", "width:100%", "height:100%",
    `padding:${cssSides(P)}`, `gap:${cssPx(s.gap != null ? s.gap : 12)}`,
    `overflow:${s.overflow === "scroll" ? "auto" : s.overflow === "clip" ? "hidden" : "visible"}`];
  if (layout === "table") out.push("display:grid", `grid-template-columns:repeat(${Math.max(1, s.cols || 1)},minmax(0,1fr))`);
  else out.push("display:flex", `flex-direction:${layout === "horizontal" ? "row" : "column"}`,
    `align-items:${cssAlign(s.align)}`, `flex-wrap:${s.wrap ? "wrap" : "nowrap"}`);
  return out.join(";");
}

function htmlIcon(s, assets) {
  if (!s.icon) return "";
  const src = assets.get(s.icon) || `assets/${encodeURI(s.icon)}`;
  return `<img class="sr-icon" src="${htmlEsc(src)}" alt="" style="width:${cssPx(s.iconSize || 18)};height:${cssPx(s.iconSize || 18)}">`;
}

function htmlLeaf(s, style, assets) {
  const text = htmlEsc(s.text || ""), icon = htmlIcon(s, assets);
  const attrs = `id="${cssId(s)}" class="sr-node sr-${htmlEsc(s.widget || s.type)}" data-name="${htmlEsc(s.name || "")}" style="${style}"`;
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
    case "wincontrols": return `<div ${attrs} aria-label="Window controls"><i></i><i></i><i></i></div>`;
    case "separator": case "spacer": return `<div ${attrs}></div>`;
    default: return `<div ${attrs}>${icon}${text}</div>`;
  }
}

function htmlElement(s, parent, assets, indent = 2) {
  const pad = "  ".repeat(indent), style = htmlNodeStyle(s, parent);
  if (!isContainer(s)) return pad + htmlLeaf(s, style, assets);
  const kids = childrenOf(s).sort((a, b) => slotOf(a) - slotOf(b));
  if (!kids.length) {
    const justify = s.alignH === "right" ? "flex-end" : s.alignH === "center" ? "center" : "flex-start";
    const align = s.alignV === "bottom" ? "flex-end" : s.alignV === "middle" ? "center" : "flex-start";
    return `${pad}<div id="${cssId(s)}" class="sr-node sr-${htmlEsc(s.widget)}" data-name="${htmlEsc(s.name || "")}" style="${style};display:flex;justify-content:${justify};align-items:${align};padding:${cssSides(s.padding)}">${htmlEsc(s.text || "")}</div>`;
  }
  const caption = s.widget === "section" && s.text.trim()
    ? `\n${pad}  <span class="sr-caption">${htmlEsc(s.text)}</span>` : "";
  const childHtml = kids.map(k => htmlElement(k, s, assets, indent + 2)).join("\n");
  return `${pad}<div id="${cssId(s)}" class="sr-node sr-${htmlEsc(s.widget)}" data-name="${htmlEsc(s.name || "")}" style="${style};display:flex;flex-direction:column">${caption}\n${pad}  <div class="sr-content" style="${htmlContainerStyle(s)}">\n${childHtml}\n${pad}  </div>\n${pad}</div>`;
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${htmlEsc(roots[0]?.text || roots[0]?.name || "PixelRuller design")}</title>
  <style>
    *{box-sizing:border-box} html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif;background:#171b22}
    body{display:flex;flex-direction:column;align-items:center;gap:32px;padding:16px}.sr-node{font-family:inherit}.sr-window{position:relative;overflow:hidden}
    .sr-caption{display:block;flex:0 0 22px;padding:5px 8px 0}.sr-icon{object-fit:contain;vertical-align:middle;margin-right:6px}
    button,input,select,progress{font:inherit;color:inherit}button{cursor:pointer}.sr-checkbox,.sr-radio{display:flex;align-items:center;gap:7px}.sr-checkbox>input,.sr-radio>input{accent-color:var(--sr-accent)}
    progress{appearance:none;overflow:hidden;background:#c9ced6}progress::-webkit-progress-bar{background:#c9ced6}progress::-webkit-progress-value{background:var(--sr-accent)}progress::-moz-progress-bar{background:var(--sr-accent)}
    .sr-wincontrols{display:flex;align-items:center;justify-content:flex-end;gap:10px}.sr-wincontrols i{width:18px;height:18px;border-radius:50%;background:#ff5f57}.sr-wincontrols i:nth-child(1){background:#ffbd2e}.sr-wincontrols i:nth-child(2){background:#28c840}
    .sr-tabs{display:flex}.sr-tabs>*{flex:1}.sr-tabs .active{font-weight:700}.sr-separator{border-left:1px solid currentColor!important}.sr-spacer{border:0!important}
  </style>
</head>
<body>
${body}
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
 "SizeX", "SizeY", "PercentW", "PercentH", "Grow", "MinW", "MaxW", "MinH", "MaxH", "ColSpan", "RowSpan",
 "Font", "AlignH", "AlignV", "TextColor", "Icon", "IconSize", "IconPosition", "IconGap",
 "Layout", "Align", "Gap", "Cols", "Wrap", "Overflow", "ScrollX", "ScrollY",
 "StateBool", "StateVal", "StateCount", "ScrollBind", "CornersLinked", "RadiusTL", "RadiusTR", "RadiusBR", "RadiusBL", "ResizeMode"].forEach(k =>
  PP(k).addEventListener("input", applyPropPanel));
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
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

window.addEventListener("keydown", (e) => {
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
