/* Topographic contour backdrop drawn from real elevation data.
   A baked heightmap (data/terrain/<slug>.bin, Uint16 metres) is sampled onto a
   screen grid and traced with marching squares. The contour levels creep slowly
   uphill and the view drifts very slowly; nothing reacts to the pointer.
   Location: <html data-terrain="..."> or ?terrain=... ; colours come from CSS vars. */
(() => {
  "use strict";

  const canvas = document.getElementById("terrain");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const root = document.documentElement;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mobileQuery = window.matchMedia("(max-width: 720px), (pointer: coarse)");

  // Per-device settings: phones get a coarser grid, lower pixel ratio and fewer frames.
  const PROFILES = {
    desktop: { cell: 8, dprCap: 2, fps: 15, levels: 26, zoom: 1.18 },
    mobile: { cell: 11, dprCap: 1.5, fps: 8, levels: 20, zoom: 1.12 },
  };
  let profile = mobileQuery.matches ? PROFILES.mobile : PROFILES.desktop;

  const INDEX_EVERY = 5;          // every Nth contour is drawn heavier
  const CREEP_SECONDS = 45;       // time for the contours to rise by one interval
  const DRIFT_SECONDS = 240;      // period of the slow camera drift
  const SCROLL_PARALLAX = 0.06;
  const SMOOTH_RADIUS = 2;        // heightmap blur, in heightmap pixels

  let terrain = null;             // { w, h, data: Float32Array normalised 0..1 }
  let W = 0, H = 0, dpr = 1, cols = 0, rows = 0;
  let field = new Float32Array(0);
  let colors = {};
  let phase = 0;                  // grows forever; fractional part = creep
  let clock = 0;                  // seconds of animation
  const view = { scale: 1, ox: 0, oy: 0 };

  // ---------- Data ----------
  async function loadTerrain() {
    const params = new URLSearchParams(location.search);
    const index = await fetch("data/terrain/index.json").then((r) => r.json());
    const wanted = params.get("terrain") || root.dataset.terrain || index.locations[0].slug;
    const loc = index.locations.find((l) => l.slug === wanted) || index.locations[0];
    const buf = await fetch(`data/terrain/${loc.slug}.bin`).then((r) => r.arrayBuffer());
    const raw = new Int16Array(buf); // metres; negative = below sea level
    const data = new Float32Array(raw.length);
    const span = Math.max(1, loc.max - loc.min);
    // "sqrt" spreads contours across flat coastal land and shallow sea alike
    const f = loc.scale === "sqrt" ? (v) => Math.sign(v) * Math.sqrt(Math.abs(v)) : (v) => v;
    const lo = f(loc.min), fspan = Math.max(1e-6, f(loc.max) - lo);
    for (let i = 0; i < raw.length; i++) data[i] = (f(raw[i]) - lo) / fspan;
    coastLevel = loc.min < 0 ? (f(0) - lo) / fspan : null;
    if (coastLevel !== null) seaMask = buildSeaMask(raw, loc.width, loc.height);
    // relief layers use a lightly smoothed copy (more detail than the contour field)
    const detail = data.slice();
    smooth(detail, loc.width, loc.height, 1, 1);
    smooth(data, loc.width, loc.height, SMOOTH_RADIUS, 3);
    terrain = { w: loc.width, h: loc.height, data };
    canvas.dataset.location = loc.label;
    // don't hold the contours back while an image layer loads
    buildRelief(loc, detail, span).then(draw).catch((e) => console.warn("relief:", e));
    const credit = document.getElementById("map-credit");
    if (credit) {
      const layer = RELIEF_CREDITS[reliefMode] || "";
      const src = loc.min < 0 ? "SRTM elevation and ETOPO1 bathymetry" : "SRTM elevation data";
      credit.textContent = `Contours: ${loc.label}, from ${src}.` + (layer ? ` ${layer}` : "");
    }
  }

  // ---------- Sea ----------
  let coastLevel = null, seaMask = null;
  let PAD = 0, CH = 0, drawScroll = 0;   // canvas overscan, canvas height, scrollY at last draw
  function buildSeaMask(raw, w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d");
    const im = cx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      im.data[i * 4 + 3] = raw[i] < 0 ? Math.min(255, 150 + Math.min(105, -raw[i] / 3)) : 0;
    }
    cx.putImageData(im, 0, 0);
    // tint with --sea
    cx.globalCompositeOperation = "source-in";
    cx.fillStyle = getComputedStyle(root).getPropertyValue("--sea").trim() || "rgb(120,160,170)";
    cx.fillRect(0, 0, w, h);
    return c;
  }

  // ---------- Relief layer under the contours ----------
  // Modes (<html data-relief> or ?relief=): none | hillshade | atlas | satellite | district-map | survey-1910
  // hillshade / atlas / satellite line up with the contours and drift with them;
  // the historical maps are a fixed wash (they are not georeferenced).
  const RELIEF_CREDITS = {
    satellite: "Imagery: EOxCloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY-NC-SA 4.0.",
    streets: "Map data © OpenStreetMap contributors (ODbL).",
    map: "Map data © OpenStreetMap contributors (ODbL).",
    "streets-colour": "Map data © OpenStreetMap contributors (ODbL).",
    "district-map": "Map: Nilgiri District, c. 1900, public domain (Wikimedia Commons).",
    "survey-1910": "Map: Survey of India sheet 58 A/7, 1910, public domain (Wikimedia Commons).",
    "map-1758": "Map: Bellin, Plan de Madras, 1758, public domain (Wikimedia Commons).",
    "map-1822": "Map: Plan of the Town of Madras, 1822, public domain (Wikimedia Commons).",
    "map-1909": "Map: Madras and environs, Imperial Gazetteer of India, 1909, public domain (Wikimedia Commons).",
    "map-1914": "Map: Madras, Baedeker, 1914, public domain (Wikimedia Commons).",
    "map-1929": "Map: Madras Town topographical map, Survey of India, 1929, public domain (Wikimedia Commons).",
  };
  // image layers that cover exactly the heightmap footprint (they drift with the contours)
  const ALIGNED = new Set(["satellite", "streets", "streets-colour", "map"]);
  const isWash = (m) => m === "district-map" || m === "survey-1910" || m.startsWith("map-");

  const params0 = new URLSearchParams(location.search);
  const reliefMode = params0.get("relief") || root.dataset.relief || "none";
  root.dataset.relief = reliefMode;
  let reliefSrc = null;           // canvas or image covering the heightmap footprint
  let reliefCanvas = null, rctx = null;

  function hillshade(h, w, hgt, metresPerPx, span, exaggeration) {
    const out = new Float32Array(w * hgt);
    const zen = (45 * Math.PI) / 180, az = (315 * Math.PI) / 180;
    const flat = Math.cos(zen);
    const k = (span / metresPerPx) * exaggeration;
    for (let y = 0; y < hgt; y++) {
      for (let x = 0; x < w; x++) {
        const l = h[y * w + Math.max(0, x - 1)], r = h[y * w + Math.min(w - 1, x + 1)];
        const u = h[Math.max(0, y - 1) * w + x], d = h[Math.min(hgt - 1, y + 1) * w + x];
        const dzdx = ((r - l) / 2) * k, dzdy = ((d - u) / 2) * k;
        const slope = Math.atan(Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        const s = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
        out[y * w + x] = Math.max(0, Math.min(1.25, s / flat)); // 1 = flat ground
      }
    }
    return out;
  }

  const ATLAS = [ // classic hypsometric ramp, low -> high
    [0, [150, 188, 122]], [0.3, [200, 214, 146]], [0.55, [228, 206, 150]],
    [0.8, [196, 160, 118]], [1, [240, 236, 228]],
  ];
  function ramp(t) {
    for (let i = 1; i < ATLAS.length; i++) {
      if (t <= ATLAS[i][0]) {
        const [t0, c0] = ATLAS[i - 1], [t1, c1] = ATLAS[i];
        const f = (t - t0) / (t1 - t0);
        return c0.map((c, j) => c + (c1[j] - c) * f);
      }
    }
    return ATLAS[ATLAS.length - 1][1];
  }

  async function buildRelief(loc, detail, span) {
    if (reliefMode === "none") return;
    if (isWash(reliefMode)) {
      const wash = document.createElement("div");
      wash.className = "relief-wash";
      wash.setAttribute("aria-hidden", "true");
      wash.style.backgroundImage = `url(assets/relief/${loc.slug}-${reliefMode}.jpg)`;
      canvas.before(wash);
      setTimeout(() => wash.classList.add("is-ready"), 30);
      return;
    }
    reliefCanvas = document.createElement("canvas");
    reliefCanvas.id = "relief";
    reliefCanvas.setAttribute("aria-hidden", "true");
    canvas.before(reliefCanvas);
    rctx = reliefCanvas.getContext("2d");

    if (ALIGNED.has(reliefMode)) {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = rej;
        // "map" = the street map drawn in the current theme's palette
        const file = reliefMode === "map" ? `streets-${root.dataset.theme || "sage"}` : reliefMode;
        img.src = `assets/relief/${loc.slug}-${file}.jpg`;
      });
      reliefSrc = img;
    } else {
      const { w, h } = terrain;
      const mpp = (156543.03 * Math.cos((loc.lat * Math.PI) / 180)) / 2 ** (loc.z || 11) * 4;
      const hs = hillshade(detail, w, h, mpp, span, 1.6);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const cx = c.getContext("2d");
      const im = cx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        let rgb;
        if (reliefMode === "atlas") rgb = ramp(detail[i]).map((v) => v * Math.min(1.08, 0.55 + 0.45 * hs[i]));
        else { const g = 255 * (1 - 0.85 * (1 - Math.min(1, hs[i]))); rgb = [g, g, g]; }
        im.data[i * 4] = rgb[0]; im.data[i * 4 + 1] = rgb[1]; im.data[i * 4 + 2] = rgb[2]; im.data[i * 4 + 3] = 255;
      }
      cx.putImageData(im, 0, 0);
      reliefSrc = c;
    }
    sizeRelief();
    setTimeout(() => reliefCanvas.classList.add("is-ready"), 30);
  }

  function sizeRelief() {
    if (!reliefCanvas) return;
    reliefCanvas.width = Math.round(W * Math.min(dpr, 1.5));
    reliefCanvas.height = Math.round(CH * Math.min(dpr, 1.5));
    reliefCanvas.style.height = CH + "px";
    reliefCanvas.style.top = -PAD + "px";
  }

  function drawRelief() {
    if (!rctx || !reliefSrc) return;
    const s = reliefCanvas.width / W;
    rctx.setTransform(s, 0, 0, s, 0, 0);
    rctx.imageSmoothingQuality = "high";
    rctx.drawImage(reliefSrc, -view.ox, -view.oy, terrain.w * view.scale, terrain.h * view.scale);
  }

  // Repeated box blur (approximates a Gaussian) so contours read as smooth, map-like curves.
  function smooth(a, w, h, r, passes) {
    const tmp = new Float32Array(a.length);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {
        let s = 0;
        for (let x = -r; x <= r; x++) s += a[y * w + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          tmp[y * w + x] = s / (2 * r + 1);
          s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = s / (2 * r + 1);
          s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
      }
    }
  }

  function sample(u, v) {
    // bilinear sample in heightmap pixel coords, clamped
    const { w, h, data } = terrain;
    u = Math.max(0, Math.min(w - 1.001, u));
    v = Math.max(0, Math.min(h - 1.001, v));
    const x = u | 0, y = v | 0, fx = u - x, fy = v - y;
    const i = y * w + x;
    const a = data[i], b = data[i + 1], c = data[i + w], d = data[i + w + 1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  // ---------- Setup ----------
  function readColors() {
    const cs = getComputedStyle(root);
    colors = {
      line: cs.getPropertyValue("--contour").trim() || "rgba(150,128,92,.34)",
      index: cs.getPropertyValue("--contour-index").trim() || "rgba(128,104,68,.62)",
      coast: cs.getPropertyValue("--coast").trim() || "rgba(60,80,90,.7)",
    };
  }

  function resize() {
    profile = mobileQuery.matches ? PROFILES.mobile : PROFILES.desktop;
    dpr = Math.min(window.devicePixelRatio || 1, profile.dprCap);
    W = window.innerWidth;
    // On phones the URL bar resizes innerHeight while scrolling; use the large viewport
    // so the canvas doesn't redraw on every scroll.
    H = mobileQuery.matches ? Math.max(window.innerHeight, screen.height || 0) : window.innerHeight;
    // Overscan above and below the viewport: scroll parallax is applied as a cheap
    // CSS transform every frame, and the canvas is only redrawn at the profile fps.
    PAD = Math.round(H * 0.15);
    CH = H + 2 * PAD;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(CH * dpr);
    canvas.style.height = CH + "px";
    canvas.style.top = -PAD + "px";
    cols = Math.ceil(W / profile.cell) + 1;
    rows = Math.ceil(CH / profile.cell) + 1;
    field = new Float32Array((cols + 1) * (rows + 1));
    sizeRelief();
  }

  // ---------- Field: map the heightmap onto the screen ("cover" fit) with slow drift ----------
  function computeField() {
    const { w, h } = terrain;
    const scale = Math.max(W / w, H / h) * profile.zoom; // screen px per heightmap px
    const t = (clock / DRIFT_SECONDS) * Math.PI * 2;
    const slackX = (w * scale - W) / 2, slackY = (h * scale - H) / 2;
    const ox = (w * scale - W) / 2 + Math.sin(t) * slackX * 0.7;
    drawScroll = window.scrollY;
    const oy = (h * scale - H) / 2 + Math.cos(t * 0.73) * slackY * 0.7 - drawScroll * SCROLL_PARALLAX - PAD;
    view.scale = scale; view.ox = ox; view.oy = oy;
    const cell = profile.cell;
    let i = 0;
    for (let r = 0; r <= rows; r++) {
      const v = (r * cell + oy) / scale;
      for (let c = 0; c <= cols; c++) field[i++] = sample((c * cell + ox) / scale, v);
    }
  }

  // Marching squares for one level, appended to the current path.
  function traceLevel(L) {
    const stride = cols + 1, cell = profile.cell;
    for (let r = 0; r < rows; r++) {
      const y = r * cell, row = r * stride;
      for (let c = 0; c < cols; c++) {
        const a = field[row + c], b = field[row + c + 1];
        const cc = field[row + stride + c + 1], d = field[row + stride + c];
        const code = (a >= L ? 8 : 0) | (b >= L ? 4 : 0) | (cc >= L ? 2 : 0) | (d >= L ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const x = c * cell;
        const tx = () => x + cell * ((L - a) / (b - a));
        const ry = () => y + cell * ((L - b) / (cc - b));
        const bx = () => x + cell * ((L - d) / (cc - d));
        const ly = () => y + cell * ((L - a) / (d - a));
        switch (code) {
          case 1: case 14: ctx.moveTo(x, ly()); ctx.lineTo(bx(), y + cell); break;
          case 2: case 13: ctx.moveTo(bx(), y + cell); ctx.lineTo(x + cell, ry()); break;
          case 3: case 12: ctx.moveTo(x, ly()); ctx.lineTo(x + cell, ry()); break;
          case 4: case 11: ctx.moveTo(tx(), y); ctx.lineTo(x + cell, ry()); break;
          case 6: case 9: ctx.moveTo(tx(), y); ctx.lineTo(bx(), y + cell); break;
          case 7: case 8: ctx.moveTo(x, ly()); ctx.lineTo(tx(), y); break;
          case 5:
            ctx.moveTo(x, ly()); ctx.lineTo(tx(), y);
            ctx.moveTo(bx(), y + cell); ctx.lineTo(x + cell, ry()); break;
          case 10:
            ctx.moveTo(tx(), y); ctx.lineTo(x + cell, ry());
            ctx.moveTo(x, ly()); ctx.lineTo(bx(), y + cell); break;
        }
      }
    }
  }

  function draw() {
    if (!terrain) return;
    computeField();
    drawRelief();
    const STEP = 1 / profile.levels;
    // Line n sits at height (n + phase) * STEP; n is stable so index lines don't jump.
    const nFirst = Math.ceil(-phase) - 1;
    const nLast = Math.floor(1 / STEP - phase) + 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, CH);
    shift();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (seaMask) {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(seaMask, -view.ox, -view.oy, terrain.w * view.scale, terrain.h * view.scale);
    }

    ctx.beginPath();
    for (let n = nFirst; n <= nLast; n++) if (n % INDEX_EVERY !== 0) traceLevel((n + phase) * STEP);
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    for (let n = nFirst; n <= nLast; n++) if (n % INDEX_EVERY === 0) traceLevel((n + phase) * STEP);
    ctx.strokeStyle = colors.index;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // the coastline stays put while the other contours creep
    if (coastLevel !== null) {
      ctx.beginPath();
      traceLevel(coastLevel);
      ctx.strokeStyle = colors.coast;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // ---------- Loop ----------
  let raf = 0, last = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / profile.fps) return;
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    clock += dt;
    // creep downward: lines drift slowly toward the peaks
    phase = -((clock / CREEP_SECONDS) % INDEX_EVERY);
    draw();
  }

  function start() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (reduceMotion.matches) { draw(); return; }
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); draw(); }, 120);
  }, { passive: true });
  // Between redraws, slide the drawn layers by however far the page has scrolled
  // since the last draw, so the parallax tracks the scroll on every frame.
  function shift() {
    const y = ((window.scrollY - drawScroll) * SCROLL_PARALLAX).toFixed(2);
    const tf = `translate3d(0, ${y}px, 0)`;
    canvas.style.transform = tf;
    if (reliefCanvas) reliefCanvas.style.transform = tf;
  }
  let shiftQueued = false;
  window.addEventListener("scroll", () => {
    if (shiftQueued) return;
    shiftQueued = true;
    requestAnimationFrame(() => {
      shiftQueued = false;
      // a big jump (anchor link, scrollbar drag) would outrun the overscan: redraw
      if (Math.abs(window.scrollY - drawScroll) * SCROLL_PARALLAX > PAD * 0.8) draw();
      else shift();
    });
  }, { passive: true });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reduceMotion.addEventListener?.("change", start);
  // theme switches (data-theme on <html>) recolour the lines
  new MutationObserver(() => { readColors(); draw(); }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  readColors();
  resize();
  loadTerrain()
    .then(() => { draw(); canvas.classList.add("is-ready"); start(); })
    .catch((e) => console.warn("terrain:", e));
})();
