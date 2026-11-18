"""Builds the image layers that can sit under the contour lines.

  * satellite: Sentinel-2 cloudless imagery for exactly the same tiles as the
    terrain heightmap, so it lines up with the contours. Greyscale.
    Licence: EOxCloudless by EOX IT Services GmbH (Contains modified Copernicus
    Sentinel data), CC BY-NC-SA 4.0 for non-commercial use. Credit shown on the page.
  * district-map / survey-1910: public-domain historical maps of the Nilgiris
    from Wikimedia Commons, cleaned up (paper pushed to white) for blending.

Run: python scripts/build-relief.py   (needs Pillow)
"""
import io
import json
import math
import pathlib
import urllib.parse
import urllib.request

from PIL import Image, ImageOps

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "relief"
OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "PortfolioBuild/1.0 (https://adichandrashekar.github.io)"}

# Must match scripts/build-terrain.mjs
TILES_X, TILES_Y = 4, 3
LOC = {"slug": "nilgiris", "lat": 11.38, "lon": 76.75, "z": 11}
CHENNAI = {"slug": "chennai", "lat": 13.06, "lon": 80.19, "z": 11}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    r = math.radians(lat)
    y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n
    return x, y


def satellite(LOC=LOC):
    cx, cy = tile_xy(LOC["lat"], LOC["lon"], LOC["z"])
    x0, y0 = round(cx - TILES_X / 2), round(cy - TILES_Y / 2)
    sheet = Image.new("RGB", (TILES_X * 256, TILES_Y * 256))
    for ty in range(TILES_Y):
        for tx in range(TILES_X):
            url = (f"https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/"
                   f"GoogleMapsCompatible/{LOC['z']}/{y0 + ty}/{x0 + tx}.jpg")
            sheet.paste(Image.open(io.BytesIO(get(url))).convert("RGB"), (tx * 256, ty * 256))
    grey = ImageOps.autocontrast(ImageOps.grayscale(sheet), cutoff=1)
    # brighten so that, when multiplied, the image reads as a light wash
    grey = grey.point(lambda v: int(90 + v * (255 - 90) / 255))
    grey.save(OUT / f"{LOC['slug']}-satellite.jpg", quality=72, optimize=True, progressive=True)
    print("  satellite", grey.size)


def commons(title, width=2000):
    q = urllib.parse.urlencode({
        "action": "query", "prop": "imageinfo", "iiprop": "url",
        "iiurlwidth": width, "format": "json", "titles": title,
    })
    data = json.loads(get("https://commons.wikimedia.org/w/api.php?" + q))
    page = next(iter(data["query"]["pages"].values()))
    return Image.open(io.BytesIO(get(page["imageinfo"][0]["thumburl"]))).convert("RGB")


def clean_paper(img, black=40, white=200, max_w=1800):
    """Greyscale and levels: paper -> white, ink stays dark, ready for multiply."""
    if img.width > max_w:
        img = img.resize((max_w, round(img.height * max_w / img.width)), Image.LANCZOS)
    g = ImageOps.grayscale(img)
    return g.point(lambda v: max(0, min(255, int((v - black) * 255 / (white - black)))))


def maps():
    # Nilgiri District map (Macmillan / Stanford, c. 1900s). Public domain.
    m = commons("File:NilgiriMap.jpg")
    w, h = m.size
    m = m.crop((int(w * 0.035), int(h * 0.06), int(w * 0.97), int(h * 0.955)))
    clean_paper(m, 30, 215).save(OUT / "nilgiris-district-map.jpg", quality=62, optimize=True, progressive=True)
    print("  district map", m.size)

    # Survey of India sheet 58 A/7, Malabar and Nilgiri, 1910. Public domain.
    s = commons("File:58 A 07 Malabar (1910).jpg")
    w, h = s.size
    s = s.crop((int(w * 0.063), int(h * 0.105), int(w * 0.935), int(h * 0.835)))
    clean_paper(s, 40, 205).save(OUT / "nilgiris-survey-1910.jpg", quality=62, optimize=True, progressive=True)
    print("  survey sheet", s.size)


def streets(loc, style, name, zoom_up=1):
    """Current street map (CARTO basemap, OpenStreetMap data) for exactly the
    terrain footprint, fetched one zoom deeper for crisper lines."""
    z = loc["z"] + zoom_up
    k = 2 ** zoom_up
    cx, cy = tile_xy(loc["lat"], loc["lon"], loc["z"])
    x0, y0 = round(cx - TILES_X / 2) * k, round(cy - TILES_Y / 2) * k
    sheet = Image.new("RGB", (TILES_X * k * 256, TILES_Y * k * 256))
    for ty in range(TILES_Y * k):
        for tx in range(TILES_X * k):
            url = f"https://a.basemaps.cartocdn.com/{style}/{z}/{x0 + tx}/{y0 + ty}.png"
            sheet.paste(Image.open(io.BytesIO(get(url))).convert("RGB"), (tx * 256, ty * 256))
    sheet = sheet.resize((1600, 1200), Image.LANCZOS)
    sheet.save(OUT / f"{loc['slug']}-{name}.jpg", quality=70, optimize=True, progressive=True)
    print(" ", name, sheet.size)


def overpass_chennai(loc, cache):
    """OpenStreetMap roads, rail and water for the terrain footprint (cached)."""
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf8"))
    n = 2 ** loc["z"]
    cx, cy = tile_xy(loc["lat"], loc["lon"], loc["z"])
    x0, y0 = round(cx - TILES_X / 2), round(cy - TILES_Y / 2)
    def ll(x, y):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n)))), x / n * 360 - 180
    (nn, ww), (ss, ee) = ll(x0, y0), ll(x0 + TILES_X, y0 + TILES_Y)
    b = f"({ss},{ww},{nn},{ee})"
    q = f"""[out:json][timeout:180];(
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]{b};
      way["railway"="rail"]{b}; way["waterway"~"^(river|canal)$"]{b};
      way["natural"="water"]{b};
      node["place"~"^(city|town|suburb)$"]["name"]{b};);out geom;"""
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
    data = urllib.request.urlopen(req, timeout=200).read()
    cache.write_bytes(data)
    return json.loads(data)


# Map palettes, one per site theme: land, sea, inland water, rivers, rail,
# roads (minor -> major) and the faint label colour.
PALETTES = {
    "coast": dict(land=(250, 247, 240), sea=(196, 220, 228), water=(184, 212, 222), river=(120, 168, 190), rail=(110, 100, 120),
                  roads=[(200, 196, 184), (200, 180, 140), (226, 178, 96), (222, 150, 80), (214, 120, 70)], label=(70, 84, 92)),
    "sage": dict(land=(239, 242, 232), sea=(200, 218, 210), water=(186, 208, 200), river=(126, 160, 148), rail=(96, 110, 100),
                 roads=[(206, 210, 194), (190, 194, 170), (188, 172, 120), (170, 150, 98), (150, 128, 82)], label=(56, 74, 62)),
    "eucalyptus": dict(land=(236, 240, 234), sea=(178, 206, 204), water=(164, 196, 194), river=(104, 150, 146), rail=(84, 104, 100),
                       roads=[(204, 212, 200), (186, 196, 176), (210, 184, 130), (204, 164, 102), (196, 146, 84)], label=(44, 70, 66)),
    "monsoon": dict(land=(230, 233, 228), sea=(160, 180, 182), water=(150, 172, 176), river=(98, 128, 134), rail=(70, 80, 84),
                    roads=[(198, 202, 194), (176, 182, 172), (150, 160, 148), (126, 142, 132), (110, 128, 118)], label=(40, 54, 56)),
    "laterite": dict(land=(242, 234, 222), sea=(190, 208, 198), water=(176, 198, 188), river=(118, 150, 136), rail=(96, 84, 76),
                     roads=[(212, 202, 186), (196, 180, 156), (204, 146, 104), (196, 116, 74), (184, 92, 56)], label=(60, 52, 44)),
    "indigo": dict(land=(240, 238, 230), sea=(184, 194, 216), water=(170, 182, 208), river=(104, 118, 162), rail=(70, 74, 104),
                   roads=[(204, 204, 212), (176, 178, 196), (130, 140, 180), (92, 106, 160), (66, 82, 140)], label=(40, 46, 80)),
}


def render_streets(loc, themes=None):
    """Draws a current map of the city from OpenStreetMap data, aligned to the terrain,
    once per palette, with faint place-name labels."""
    from PIL import ImageDraw
    import array
    cache = ROOT / "scripts" / ".cache" / f"{loc['slug']}-{loc['lon']}-osm.json"
    cache.parent.mkdir(exist_ok=True)
    osm = overpass_chennai(loc, cache)
    S = 4  # supersample, then downscale for anti-aliasing
    W, H = TILES_X * 256 * 2, TILES_Y * 256 * 2
    n = 2 ** loc["z"]
    cx, cy = tile_xy(loc["lat"], loc["lon"], loc["z"])
    x0, y0 = round(cx - TILES_X / 2), round(cy - TILES_Y / 2)
    def px(lat, lon, k=S):
        x = (lon + 180) / 360 * n
        r = math.radians(lat)
        y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n
        return ((x - x0) * 512 * k, (y - y0) * 512 * k)

    # sea from the terrain heightmap (negative = sea)
    raw = array.array("h")
    raw.frombytes((ROOT / "data" / "terrain" / f"{loc['slug']}.bin").read_bytes())
    sea = Image.new("L", (256, 192))
    sea.putdata([255 if v < 0 else 0 for v in raw])
    from PIL import ImageFilter
    sea = sea.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(6))
    sea = sea.resize((W * S, H * S), Image.BILINEAR).point(lambda v: 255 if v > 127 else 0)

    small_sea = sea.resize((W, H), Image.NEAREST)
    widths = {"motorway": 5, "trunk": 4.4, "primary": 3.4, "secondary": 2.4, "tertiary": 1.4}
    order = ["tertiary", "secondary", "primary", "trunk", "motorway"]
    els = osm["elements"]
    places = [e for e in els if e["type"] == "node" and e.get("tags", {}).get("name")]
    rank = {"city": 0, "town": 1, "suburb": 2}
    places.sort(key=lambda e: rank.get(e["tags"].get("place"), 3))
    from PIL import ImageFont
    try:
        f_big = ImageFont.truetype("C:/Windows/Fonts/segoeuisl.ttf", 30)
        f_small = ImageFont.truetype("C:/Windows/Fonts/segoeuisl.ttf", 17)
        f_sea = ImageFont.truetype("C:/Windows/Fonts/georgiai.ttf", 34)
    except OSError:
        f_big = f_small = f_sea = ImageFont.load_default()

    for theme in themes or PALETTES:
        P = PALETTES[theme]
        img = Image.new("RGB", (W * S, H * S), P["land"])
        img.paste(P["sea"], mask=sea)
        d = ImageDraw.Draw(img)
        for e in els:
            if e.get("tags", {}).get("natural") == "water" and e.get("geometry"):
                pts = [px(g["lat"], g["lon"]) for g in e["geometry"]]
                if len(pts) > 2:
                    d.polygon(pts, fill=P["water"])
        for e in els:
            if e.get("tags", {}).get("waterway") and e.get("geometry"):
                d.line([px(g["lat"], g["lon"]) for g in e["geometry"]], fill=P["river"], width=int(2.4 * S))
        for e in els:
            if e.get("tags", {}).get("railway") and e.get("geometry"):
                d.line([px(g["lat"], g["lon"]) for g in e["geometry"]], fill=P["rail"], width=int(1.6 * S))
        for i, kind in enumerate(order):
            for e in els:
                if e.get("tags", {}).get("highway") == kind and e.get("geometry"):
                    d.line([px(g["lat"], g["lon"]) for g in e["geometry"]], fill=P["roads"][4 - i],
                           width=max(1, int(widths[kind] * S * 0.55)), joint="curve")
        img = img.resize((W, H), Image.LANCZOS)

        # Faint place-name labels, drawn at final size with a soft halo; no overlaps.
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        boxes = []

        def place_text(x, y, text, font, alpha):
            bb = ld.textbbox((0, 0), text, font=font)
            w_, h_ = bb[2] - bb[0], bb[3] - bb[1]
            box = (x - w_ / 2 - 8, y - h_ / 2 - 6, x + w_ / 2 + 8, y + h_ / 2 + 6)
            if box[0] < 4 or box[1] < 4 or box[2] > W - 4 or box[3] > H - 4:
                return
            if any(not (box[2] < b[0] or box[0] > b[2] or box[3] < b[1] or box[1] > b[3]) for b in boxes):
                return
            boxes.append(box)
            ld.text((x - w_ / 2, y - h_ / 2), text, font=font, fill=P["label"] + (alpha,),
                    stroke_width=3, stroke_fill=P["land"] + (int(alpha * 0.9),))

        place_text(W * 0.86, H * 0.5, "Bay of Bengal", f_sea, 120)
        for e in places:
            x, y = px(e["lat"], e["lon"], 1)
            if small_sea.getpixel((int(min(W - 1, max(0, x))), int(min(H - 1, max(0, y))))) > 0:
                continue
            name = e["tags"].get("name:en") or e["tags"]["name"]
            if not name.isascii():
                continue
            if e["tags"].get("place") in ("city", "town"):
                place_text(x, y, " ".join(name.upper()), f_big, 110)
            else:
                place_text(x, y, name.upper(), f_small, 95)
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        out = OUT / f"{loc['slug']}-streets-{theme}.jpg"
        img.save(out, quality=72, optimize=True, progressive=True)
        print(" ", out.name, img.size, len(boxes), "labels")


def clean_colour(img, max_w=1800, cutoff=1):
    """Keep colour, but stretch levels so the paper reads as near-white."""
    if img.width > max_w:
        img = img.resize((max_w, round(img.height * max_w / img.width)), Image.LANCZOS)
    return ImageOps.autocontrast(img, cutoff=cutoff)


def madras_maps():
    out = lambda n: OUT / f"chennai-{n}.jpg"
    save = lambda im, n: (im.save(out(n), quality=64, optimize=True, progressive=True), print(" ", n, im.size))

    # Bellin, Plan de Madras, 1758. Sea is at the top: rotate so the sea is east (right).
    m = commons("File:Plan de Madras 1758 Bellin.jpg", 2400)
    w, h = m.size
    m = m.crop((int(w * 0.01), int(h * 0.02), int(w * 0.70), int(h * 0.97))).rotate(-90, expand=True)
    save(clean_colour(m), "map-1758")

    # Town of Madras, 1822. Sea at the bottom: rotate so the sea is east.
    m = commons("File:Madras 1822.jpg", 2600)
    w, h = m.size
    m = m.crop((0, 0, w, int(h * 0.62))).rotate(90, expand=True)
    save(clean_colour(m), "map-1822")

    # Imperial Gazetteer of India, Madras City, 1909.
    m = commons("File:Madras City 1909.jpg", 1000)
    w, h = m.size
    save(clean_colour(m.crop((int(w * 0.03), int(h * 0.03), int(w * 0.97), int(h * 0.97)))), "map-1909")

    # Baedeker, Madras 1:30,000, 1914.
    m = commons("File:Madras (Baedeker, 1914).jpg", 1721)
    w, h = m.size
    save(clean_colour(m.crop((int(w * 0.04), int(h * 0.03), int(w * 0.96), int(h * 0.97)))), "map-1914")

    # Survey of India, Madras Town topographical map, 1929.
    m = commons("File:Madras Town topographical map (1929).jpg", 1800)
    w, h = m.size
    save(clean_colour(m.crop((int(w * 0.03), int(h * 0.02), int(w * 0.97), int(h * 0.98)))), "map-1929")


if __name__ == "__main__":
    import sys
    if "chennai" in sys.argv:
        satellite(CHENNAI)
        render_streets(CHENNAI)
        madras_maps()
    else:
        satellite()
        maps()
