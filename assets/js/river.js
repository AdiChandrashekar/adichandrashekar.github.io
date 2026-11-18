/* River emphasis: a hand-drawn river under each highlighted word.
   Each river is generated from the word's width: an irregular meander (no
   repeating wave), a body that swells and tapers like a brush stroke, a
   fainter ink-bleed pass, and a thin bank line that wanders alongside.
   Shapes are seeded from the word, so they stay the same on every visit. */
(() => {
  "use strict";
  const root = document.documentElement;
  if (root.dataset.emph !== "river") return;
  const NS = "http://www.w3.org/2000/svg";

  function rng(seedText) {
    let h = 2166136261;
    for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return () => {
      h += 0x6d2b79f5;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Smooth value noise along x: a few random control points, cosine-interpolated.
  function noise1d(rand, count) {
    const pts = Array.from({ length: count + 1 }, () => rand() * 2 - 1);
    return (t) => {
      const x = t * count, i = Math.min(count - 1, Math.floor(x)), f = x - i;
      const k = (1 - Math.cos(f * Math.PI)) / 2;
      return pts[i] * (1 - k) + pts[i + 1] * k;
    };
  }

  function smoothPath(pts) {
    // Catmull-Rom through the points, as cubic Béziers
    let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
    return d;
  }

  function build(el) {
    el.querySelector(":scope > .river")?.remove();
    const em = parseFloat(getComputedStyle(el).fontSize);
    const w = el.getBoundingClientRect().width + em * 0.12;
    const H = em * 0.5, mid = H * 0.42;
    const rand = rng(el.textContent.trim());
    const swell = noise1d(rand, 4);            // width variation
    const jitter = noise1d(rand, 9);           // irregularity in the bends

    // Sine-generated curve (Langbein & Leopold): the channel's heading swings
    // back and forth as it flows, which is how real rivers meander.
    const M = 240, loops = Math.max(1.6, w / (em * 1.15)), omega = 0.95, phi = rand() * Math.PI * 2;
    let px = 0, py = 0;
    const raw = [[0, 0]];
    for (let k = 1; k <= M; k++) {
      const s = k / M;
      const th = omega * Math.sin(2 * Math.PI * loops * s + phi) * (0.75 + 0.45 * jitter(s));
      px += Math.cos(th); py += Math.sin(th);
      raw.push([px, py]);
    }
    // straighten the overall trend, then fit to the word's width and a gentle height
    const last = raw[raw.length - 1];
    const slope = last[1] / last[0];
    let maxDev = 1e-6;
    for (const p of raw) { p[1] -= slope * p[0]; maxDev = Math.max(maxDev, Math.abs(p[1])); }
    const sx = w / last[0], sy = (em * 0.11) / maxDev;
    const N = Math.max(40, Math.round(w / 4));
    const centre = [];
    for (let i = 0; i <= N; i++) {
      const p = raw[Math.round((i / N) * M)];
      centre.push([p[0] * sx - em * 0.06, mid + p[1] * sy]);
    }

    const top = [], bot = [], bank = [];
    const maxHalf = em * 0.055;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const [x, y] = centre[i];
      const a = centre[Math.max(0, i - 1)], b = centre[Math.min(N, i + 1)];
      let nx = -(b[1] - a[1]), ny = b[0] - a[0];
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      // brush taper: thin source, full body, long thin mouth
      const taper = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.12)), 0.65) * (t < 0.05 ? t / 0.05 : 1);
      const half = Math.max(0.4, maxHalf * taper * (0.72 + 0.45 * swell(t)));
      top.push([x + nx * half, y + ny * half]);
      bot.push([x - nx * half, y - ny * half]);
      const off = em * 0.1 * (0.85 + 0.3 * jitter(Math.min(1, t + 0.1)));
      bank.push([x - nx * off, y - ny * off]);
    }
    const body = smoothPath(top) + " L" + smoothPath(bot.slice().reverse()).slice(1) + " Z";

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "river");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("viewBox", `${-em * 0.06} 0 ${w} ${H}`);
    svg.setAttribute("width", w);
    svg.setAttribute("height", H);
    // a tributary that curves in from below and joins the main channel
    const j = Math.round(N * (0.5 + rand() * 0.2));
    const join = centre[j];
    const len = em * (0.55 + rand() * 0.3);
    const trib = [];
    for (let k = 0; k <= 8; k++) {
      const u = k / 8;
      trib.push([join[0] - len * (1 - u), join[1] + em * 0.16 * Math.pow(1 - u, 1.4) + Math.sin(u * 5 + rand()) * em * 0.012]);
    }
    const bankStart = Math.round(N * (0.12 + rand() * 0.15)), bankEnd = Math.round(N * (0.55 + rand() * 0.3));
    svg.innerHTML =
      `<path class="river-bleed" d="${body}" transform="translate(${(em * 0.012).toFixed(2)} ${(em * 0.014).toFixed(2)})"/>` +
      `<path class="river-body" d="${body}"/>` +
      `<path class="river-bank" d="${smoothPath(bank.slice(bankStart, bankEnd))}"/>` +
      `<path class="river-trib" d="${smoothPath(trib)}"/>`;
    svg.querySelector(".river-bank").style.strokeWidth = Math.max(0.6, em * 0.012) + "px";
    svg.querySelector(".river-trib").style.strokeWidth = Math.max(0.8, em * 0.026) + "px";
    el.appendChild(svg);
  }

  const words = [...document.querySelectorAll(".hl")];
  const all = () => words.forEach(build);
  all();
  document.fonts?.ready.then(all);
  let t = 0;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(all, 150); });
})();
