/* Topographic contour backdrop.
   Animated 3D simplex noise -> height field -> marching squares isolines.
   The pointer raises a soft hill, and the contour you are "standing on" lights up.
   Colours come from CSS custom properties (see tokens.css). */
(() => {
  "use strict";

  const canvas = document.getElementById("terrain");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");

  // ---------- Simplex noise (3D), after Stefan Gustavson ----------
  const grad3 = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  ]);
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  (function seed(s) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      s = (s * 16807) % 2147483647;
      const j = s % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod12[i] = perm[i] % 12; }
  })(1802); // the year the Great Trigonometrical Survey began

  const F3 = 1 / 3, G3 = 1 / 6;
  function noise3(x, y, z) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, tt, g;
    tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) { g = permMod12[ii + perm[jj + perm[kk]]] * 3; tt *= tt; n += tt * tt * (grad3[g] * x0 + grad3[g + 1] * y0 + grad3[g + 2] * z0); }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) { g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; tt *= tt; n += tt * tt * (grad3[g] * x1 + grad3[g + 1] * y1 + grad3[g + 2] * z1); }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) { g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; tt *= tt; n += tt * tt * (grad3[g] * x2 + grad3[g + 1] * y2 + grad3[g + 2] * z2); }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) { g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; tt *= tt; n += tt * tt * (grad3[g] * x3 + grad3[g + 1] * y3 + grad3[g + 2] * z3); }
    return 32 * n; // roughly -1..1
  }

  // ---------- Settings ----------
  const CELL = 11;            // grid spacing in CSS px
  const SCALE = 560;          // terrain feature size in px
  const STEP = 0.085;         // height between contours
  const INDEX_EVERY = 5;      // every Nth line is an index contour
  const HILL_RADIUS = 150;    // pointer hill radius in px
  const HILL_HEIGHT = 0.42;
  const TIME_SPEED = 0.000035;
  const SCROLL_PARALLAX = 0.22;

  let W = 0, H = 0, dpr = 1, cols = 0, rows = 0;
  let field = new Float32Array(0);
  let time = 0;
  let colors = {};

  const pointer = { x: -9999, y: -9999, sx: -9999, sy: -9999, hill: 0, target: 0 };

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    colors = {
      line: cs.getPropertyValue("--contour").trim() || "rgba(150,128,92,.34)",
      index: cs.getPropertyValue("--contour-index").trim() || "rgba(128,104,68,.62)",
      accent: cs.getPropertyValue("--contour-accent").trim() || "rgba(177,77,40,.9)",
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    cols = Math.ceil(W / CELL) + 1;
    rows = Math.ceil(H / CELL) + 1;
    field = new Float32Array((cols + 1) * (rows + 1));
  }

  function height(x, y, scroll) {
    const nx = x / SCALE;
    const ny = (y + scroll * SCROLL_PARALLAX) / SCALE;
    let v =
      0.64 * noise3(nx, ny, time) +
      0.27 * noise3(nx * 2.03 + 11.7, ny * 2.03 - 3.1, time * 1.35) +
      0.09 * noise3(nx * 4.1 - 7.3, ny * 4.1 + 5.9, time * 1.8);
    // gentle overall slope so the land reads like a valley running across the page
    v += (y / Math.max(H, 1) - 0.5) * 0.18;
    if (pointer.hill > 0.001) {
      const dx = x - pointer.sx, dy = y - pointer.sy;
      v += pointer.hill * HILL_HEIGHT * Math.exp(-(dx * dx + dy * dy) / (2 * HILL_RADIUS * HILL_RADIUS));
    }
    return v;
  }

  function computeField() {
    const scroll = window.scrollY;
    let i = 0;
    for (let r = 0; r <= rows; r++) {
      const y = r * CELL;
      for (let c = 0; c <= cols; c++) field[i++] = height(c * CELL, y, scroll);
    }
  }

  // Marching squares for one level, appended to the current path.
  function traceLevel(L) {
    const stride = cols + 1;
    for (let r = 0; r < rows; r++) {
      const y = r * CELL;
      const row = r * stride;
      for (let c = 0; c < cols; c++) {
        const a = field[row + c];               // top-left
        const b = field[row + c + 1];           // top-right
        const cc = field[row + stride + c + 1]; // bottom-right
        const d = field[row + stride + c];      // bottom-left
        const code = (a >= L ? 8 : 0) | (b >= L ? 4 : 0) | (cc >= L ? 2 : 0) | (d >= L ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const x = c * CELL;
        // edge points (computed lazily)
        const top = () => [x + CELL * ((L - a) / (b - a)), y];
        const right = () => [x + CELL, y + CELL * ((L - b) / (cc - b))];
        const bottom = () => [x + CELL * ((L - d) / (cc - d)), y + CELL];
        const left = () => [x, y + CELL * ((L - a) / (d - a))];
        let p, q;
        switch (code) {
          case 1: case 14: p = left(); q = bottom(); break;
          case 2: case 13: p = bottom(); q = right(); break;
          case 3: case 12: p = left(); q = right(); break;
          case 4: case 11: p = top(); q = right(); break;
          case 6: case 9: p = top(); q = bottom(); break;
          case 7: case 8: p = left(); q = top(); break;
          case 5: {
            p = left(); q = top(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
            p = bottom(); q = right(); break;
          }
          case 10: {
            p = top(); q = right(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
            p = left(); q = bottom(); break;
          }
        }
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      }
    }
  }

  let pointerLevel = null;

  function draw() {
    computeField();

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < field.length; i++) {
      const v = field[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const first = Math.ceil(min / STEP);
    const last = Math.floor(max / STEP);

    // Which contour is under the pointer?
    pointerLevel = null;
    if (pointer.hill > 0.05) {
      pointerLevel = Math.round(height(pointer.sx, pointer.sy, window.scrollY) / STEP);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // regular lines
    ctx.beginPath();
    for (let k = first; k <= last; k++) {
      if (k % INDEX_EVERY === 0 || k === pointerLevel) continue;
      traceLevel(k * STEP);
    }
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.stroke();

    // index lines
    ctx.beginPath();
    for (let k = first; k <= last; k++) {
      if (k % INDEX_EVERY !== 0 || k === pointerLevel) continue;
      traceLevel(k * STEP);
    }
    ctx.strokeStyle = colors.index;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // the line you're standing on
    if (pointerLevel !== null) {
      ctx.beginPath();
      traceLevel(pointerLevel * STEP);
      ctx.strokeStyle = colors.accent;
      ctx.globalAlpha = Math.min(1, pointer.hill);
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    emitReadout();
  }

  // ---------- Readout (fake survey coordinates over Uttar Pradesh) ----------
  const elCoords = document.getElementById("readout-coords");
  const elElev = document.getElementById("readout-elev");
  let lastReadout = 0;
  function emitReadout() {
    if (!elCoords || !elElev) return;
    const now = performance.now();
    if (now - lastReadout < 90) return;
    lastReadout = now;
    const px = pointer.sx > -999 ? pointer.sx : W * 0.6;
    const py = pointer.sy > -999 ? pointer.sy : H * 0.4;
    const lat = 30.4 - (py / Math.max(H, 1)) * (30.4 - 23.9);
    const lon = 77.1 + (px / Math.max(W, 1)) * (84.6 - 77.1);
    const h = height(px, py, window.scrollY);
    const metres = Math.round(60 + (h + 1) * 260);
    elCoords.textContent = `${lat.toFixed(2)}°N ${lon.toFixed(2)}°E`;
    elElev.textContent = `elev ${metres} m`;
  }

  // ---------- Loop ----------
  let raf = 0, lastFrame = 0;
  const FRAME_MS = 1000 / 30;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - lastFrame < FRAME_MS) return;
    const dt = Math.min(now - lastFrame, 100);
    lastFrame = now;
    time += dt * TIME_SPEED;
    // ease pointer and hill
    if (pointer.sx < -999) { pointer.sx = pointer.x; pointer.sy = pointer.y; }
    pointer.sx += (pointer.x - pointer.sx) * 0.12;
    pointer.sy += (pointer.y - pointer.sy) * 0.12;
    pointer.hill += (pointer.target - pointer.hill) * 0.06;
    draw();
  }

  function start() {
    cancelAnimationFrame(raf);
    if (reduceMotion.matches) { draw(); return; }
    lastFrame = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() { cancelAnimationFrame(raf); raf = 0; }

  // ---------- Events ----------
  window.addEventListener("resize", () => { resize(); draw(); }, { passive: true });
  if (finePointer.matches) {
    window.addEventListener("pointermove", (e) => {
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.target = 1;
    }, { passive: true });
    document.addEventListener("pointerleave", () => { pointer.target = 0; });
  }
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reduceMotion.addEventListener?.("change", start);

  readColors();
  resize();
  start();

  window.Terrain = { refreshColors() { readColors(); draw(); } };
})();
