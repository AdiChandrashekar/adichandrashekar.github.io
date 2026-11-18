(() => {
  "use strict";

  document.documentElement.classList.add("js");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const isPhone = window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;

  // ---------- Email: assembled only at click time, never in the HTML ----------
  const mailParts = {
    u: [97, 100, 105, 99, 104, 97, 110, 100, 114, 97, 115, 104, 101, 107, 97, 114, 51, 54],
    d: [103, 109, 97, 105, 108, 46, 99, 111, 109],
  };
  document.querySelectorAll("[data-email]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const addr = String.fromCharCode(...mailParts.u) + "@" + String.fromCharCode(...mailParts.d);
      window.location.href = "mailto:" + addr;
    });
  });

  // ---------- Helpers ----------
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

  async function getJson(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(path + " " + res.status);
    return res.json();
  }

  // ---------- Writing ----------
  const postsEl = document.getElementById("posts");
  getJson("data/posts.json")
    .then(({ publication, posts }) => {
      if (publication?.description) document.getElementById("pub-desc").textContent = publication.description;
      if (!posts?.length) throw new Error("no posts");
      const [first, ...rest] = posts;
      const featured = `
        <a class="post post--featured" href="${esc(first.url)}">
          ${first.image ? `<div class="post-img"><img src="${esc(first.image)}" alt="" loading="lazy" decoding="async"></div>` : ""}
          <div>
            <span class="post-kicker mono">Latest</span>
            <span class="post-title">${esc(first.title)}</span>
            <p class="post-sub">${esc(first.subtitle)}</p>
            <span class="post-meta mono">${fmtDate(first.date)} · ${first.minutes} min read</span>
          </div>
        </a>`;
      const list = rest
        .slice(0, 5)
        .map(
          (p) => `
        <a class="post" href="${esc(p.url)}">
          <span class="post-title">${esc(p.title)}</span>
          <span class="post-meta mono">${fmtDate(p.date)}</span>
          <span class="post-sub">${esc(p.subtitle)}</span>
        </a>`
        )
        .join("");
      postsEl.innerHTML = featured + list;
    })
    .catch(() => {
      postsEl.innerHTML = `<p class="muted">Posts are on <a href="https://adityachandrashekar.substack.com/">Substack</a>.</p>`;
    });

  // ---------- Projects ----------
  const projEl = document.getElementById("project-list");
  getJson("data/projects.json")
    .then(({ projects }) => {
      if (!projects?.length) throw new Error("no projects");
      projEl.innerHTML = projects
        .map((p) => {
          // Live iframe previews only on desktop; phones get the lighter screenshot.
          const preview = p.embed && !isPhone
            ? `<div class="card-preview" data-embed="${esc(p.url)}">
                 <span class="card-live mono">Live preview</span>
               </div>`
            : p.image
            ? `<div class="card-preview"><img src="${esc(p.image)}" alt="" loading="lazy" decoding="async"></div>`
            : `<div class="card-preview card-thumb" style="--seed:${(p.title.length * 37) % 100}%"></div>`;
          const tags = (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
          return `
          <article class="card${p.featured ? " card--featured" : ""}">
            <a class="card-cover" href="${esc(p.url)}" aria-label="Open ${esc(p.title)}"></a>
            ${preview}
            <div class="card-body">
              <h3 class="card-title">${esc(p.title)}</h3>
              <p class="card-blurb">${esc(p.blurb)}</p>
              <div class="card-foot">
                ${tags}
                <span class="card-links">
                  <a href="${esc(p.url)}">Open ↗</a>
                  <a href="${esc(p.source)}">Code</a>
                </span>
              </div>
            </div>
          </article>`;
        })
        .join("");
      setupEmbeds();
      setupCardSheen();
    })
    .catch(() => {
      projEl.innerHTML = `<p class="muted">Projects are on <a href="https://github.com/adichandrashekar">GitHub</a>.</p>`;
    });

  // Live, non-interactive iframe previews, loaded when near the viewport
  function setupEmbeds() {
    const holders = document.querySelectorAll("[data-embed]");
    const fit = (holder) => {
      const frame = holder.querySelector("iframe");
      if (frame) frame.style.transform = `scale(${holder.clientWidth / 1280})`;
    };
    const ro = new ResizeObserver((entries) => entries.forEach((e) => fit(e.target)));
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          io.unobserve(e.target);
          const f = document.createElement("iframe");
          f.src = e.target.dataset.embed;
          f.title = "Live preview";
          f.loading = "lazy";
          f.tabIndex = -1;
          f.setAttribute("scrolling", "no");
          f.setAttribute("aria-hidden", "true");
          f.setAttribute("sandbox", "allow-scripts allow-same-origin");
          e.target.prepend(f);
          fit(e.target);
          ro.observe(e.target);
        });
      },
      { rootMargin: "300px" }
    );
    holders.forEach((h) => io.observe(h));
  }

  function setupCardSheen() {
    if (!finePointer) return;
    document.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });
  }

  // ---------- Windows: entrance from depth + spatial tilt ----------
  const windows = document.querySelectorAll(".window");
  if (reduceMotion) {
    windows.forEach((w) => w.classList.add("is-in"));
  } else {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.08 }
    );
    windows.forEach((w) => io.observe(w));
  }

  if (finePointer && !reduceMotion && !isPhone) {
    const MAX = 3.5; // degrees
    document.querySelectorAll("[data-tilt]").forEach((w) => {
      w.addEventListener("pointermove", (e) => {
        const r = w.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        w.style.setProperty("--ry", `${(px - 0.5) * MAX * 2}deg`);
        w.style.setProperty("--rx", `${(0.5 - py) * MAX * 1.4}deg`);
        w.style.setProperty("--mx", `${e.clientX - r.left}px`);
        w.style.setProperty("--my", `${e.clientY - r.top}px`);
        w.classList.add("is-hover");
      });
      w.addEventListener("pointerleave", () => {
        w.style.setProperty("--rx", "0deg");
        w.style.setProperty("--ry", "0deg");
        w.classList.remove("is-hover");
      });
    });
  }

  // ---------- Dock: sliding lens follows the active section ----------
  const dock = document.querySelector(".dock");
  const lens = dock.querySelector(".dock-lens");
  const items = [...dock.querySelectorAll(".dock-item")];

  function moveLens(item) {
    items.forEach((i) => {
      i.classList.toggle("is-active", i === item);
      if (i === item) i.setAttribute("aria-current", "true");
      else i.removeAttribute("aria-current");
    });
    const d = dock.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    if (!r.width) return;
    lens.style.left = r.left - d.left + "px";
    lens.style.width = r.width + "px";
  }
  const remeasure = () => moveLens(items.find((i) => i.classList.contains("is-active")) || items[0]);
  window.addEventListener("load", remeasure);
  document.fonts?.ready.then(remeasure);

  const sections = items.map((i) => document.getElementById(i.dataset.section));
  const visible = new Map();
  const secIo = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => visible.set(e.target.id, e.intersectionRatio));
      let best = null, bestRatio = 0;
      for (const [id, ratio] of visible) if (ratio > bestRatio) { best = id; bestRatio = ratio; }
      // the last section is short; snap to it at the page bottom
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) best = "contact";
      if (best) moveLens(items.find((i) => i.dataset.section === best));
    },
    { threshold: [0, 0.15, 0.3, 0.5, 0.7, 1] }
  );
  sections.forEach((s) => s && secIo.observe(s));
  moveLens(items[0]);
  // Re-measure whenever the dock's size changes (web fonts loading, viewport changes)
  new ResizeObserver(() => {
    const active = items.find((i) => i.classList.contains("is-active")) || items[0];
    moveLens(active);
  }).observe(dock);
})();
