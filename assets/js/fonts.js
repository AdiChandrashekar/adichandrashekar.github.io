/* Applies the colour theme and font set before first paint.
   Defaults come from <html data-theme / data-font>; ?theme= and ?font= override for previewing.
   The default Instrument set is linked in index.html; other sets load from Google Fonts here. */
(() => {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");
  const font = params.get("font");
  if (theme) root.dataset.theme = theme;
  const emph = params.get("emph");
  if (emph) root.dataset.emph = emph;
  if (font) root.dataset.font = font;

  const G = "https://fonts.googleapis.com/css2?display=swap&family=";
  const SETS = {
    fraunces: "Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..600&family=Figtree:wght@400;500;600",
    newsreader: "Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..600&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500",
    bricolage: "Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Hanken+Grotesk:wght@400;500;600",
    syne: "Syne:wght@500..800&family=Manrope:wght@400;500;600",
    cormorant: "Cormorant+Garamond:ital,wght@0,400..600;1,400..600&family=Work+Sans:wght@400;500;600",
  };
  const set = root.dataset.font;
  if (set && SETS[set] && set !== "cormorant") { // cormorant is linked in index.html
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = G + SETS[set];
    document.head.appendChild(link);
  }
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
})();
