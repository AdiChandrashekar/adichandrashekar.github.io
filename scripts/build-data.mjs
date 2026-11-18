#!/usr/bin/env node
// Fetches the Substack RSS feed and GitHub repo metadata at build time and
// writes static JSON the page reads. Runs in GitHub Actions (daily + on push)
// and can be run locally: `node scripts/build-data.mjs`.
//
// Substack blocks CORS and framing, so the feed is only ever fetched here,
// never from the browser.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");

const FEED_URL = "https://adityachandrashekar.substack.com/feed";
const MAX_POSTS = 8;
const UA = "portfolio-site-build (+https://github.com)";

// ---------- Substack ----------

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return decodeEntities(v).trim();
}

function readingMinutes(html) {
  const words = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}

async function fetchPosts() {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const xml = await res.text();
  const channel = xml.split("<item>")[0];
  const items = xml.split("<item>").slice(1).map((chunk) => chunk.split("</item>")[0]);

  const posts = items.slice(0, MAX_POSTS).map((it) => {
    const enclosure = it.match(/<enclosure[^>]*url="([^"]+)"/);
    return {
      title: tag(it, "title"),
      subtitle: tag(it, "description"),
      url: tag(it, "link"),
      date: new Date(tag(it, "pubDate")).toISOString(),
      image: enclosure ? decodeEntities(enclosure[1]) : null,
      minutes: readingMinutes(tag(it, "content:encoded")),
    };
  });

  return {
    publication: {
      name: tag(channel, "title"),
      description: tag(channel, "description"),
      url: tag(channel, "link"),
    },
    posts,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- GitHub ----------

async function fetchRepo(owner, name) {
  const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers });
  if (!res.ok) throw new Error(`${owner}/${name}: HTTP ${res.status}`);
  return res.json();
}

async function buildProjects() {
  const config = JSON.parse(await readFile(join(dataDir, "projects.config.json"), "utf8"));
  const owner = config.owner;
  const out = [];
  for (const p of config.projects) {
    let repo = null;
    try {
      repo = await fetchRepo(owner, p.repo);
    } catch (e) {
      console.warn(`  ! ${e.message}; using config values only`);
    }
    out.push({
      repo: p.repo,
      title: p.title ?? repo?.name ?? p.repo,
      blurb: p.blurb ?? repo?.description ?? "",
      url: p.url ?? (repo?.homepage || repo?.html_url) ?? `https://github.com/${owner}/${p.repo}`,
      source: repo?.html_url ?? `https://github.com/${owner}/${p.repo}`,
      embed: Boolean(p.embed),
      image: p.image ?? null,
      tags: p.tags ?? repo?.topics?.slice(0, 3) ?? [],
      language: repo?.language ?? null,
      updated: repo?.pushed_at ?? null,
      featured: Boolean(p.featured),
    });
  }
  return { projects: out, fetchedAt: new Date().toISOString() };
}

// ---------- main ----------

async function writeJson(file, data) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, file), JSON.stringify(data, null, 2) + "\n");
  console.log(`  wrote data/${file}`);
}

let failed = false;

try {
  console.log("Substack feed");
  const posts = await fetchPosts();
  await writeJson("posts.json", posts);
} catch (e) {
  // Keep whatever posts.json already exists so a flaky feed never blanks the page.
  console.warn(`  ! could not refresh posts: ${e.message}`);
  failed = true;
}

try {
  console.log("GitHub projects");
  await writeJson("projects.json", await buildProjects());
} catch (e) {
  console.warn(`  ! could not refresh projects: ${e.message}`);
  failed = true;
}

if (failed) console.warn("Finished with warnings (existing data kept).");
