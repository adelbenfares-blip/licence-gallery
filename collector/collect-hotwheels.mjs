// collector/collect-hotwheels.mjs
// Goal: Build data/hot-wheels.json with REAL product images + URLs for Hot Wheels apparel
// Strategy: Search (DuckDuckGo HTML) -> filter to allowed retailer domains -> fetch product page -> extract og:image
// Safety: Never overwrite existing JSON with empty/junk. Dedupe aggressively.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_JSON = path.join(DATA_DIR, "hot-wheels.json");

const LICENSE = "hot wheels";

// You can extend these safely any time:
const RETAILERS = [
  { key: "zara", domains: ["zara.com", "zara.net"] },
  { key: "hm", domains: ["hm.com", "www2.hm.com"] },
  { key: "next", domains: ["next.co.uk"] },
  { key: "asos", domains: ["asos.com"] },
  { key: "zalando", domains: ["zalando.", "zalando.co.uk", "zalando.com"] },
  { key: "pinterest", domains: ["pinterest.", "pinimg.com"] }, // pinterest pins will be pinterest.*; images pinimg.com
  { key: "boxlunch", domains: ["boxlunch.com"] },
  { key: "pacsun", domains: ["pacsun.com"] },
  { key: "bucketsandspades", domains: ["bucketsandspades.", "bucketsandspades.com"] },
];

const APPAREL_TERMS = [
  "t-shirt", "t shirt", "tee", "top",
  "hoodie", "sweatshirt", "sweater",
  "jogger", "joggers", "pants", "trousers",
  "shorts", "jacket", "coat",
  "pyjama", "pajama", "pjs",
  "cap", "hat", "beanie",
  "sock", "socks",
  "set", "2 piece", "3 piece", "bundle",
];

const BAD_IMAGE_HINTS = [
  "logo",
  "android-chrome",
  "favicon",
  "sprite",
  "icon",
  "placeholder",
  "site-logo",
  "/assets/",
  "/static/",
  "rsslogo",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return [];
    const txt = fs.readFileSync(p, "utf8");
    const data = JSON.parse(txt);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function stripQuery(u) {
  try {
    const url = new URL(u);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

function guessRetailerFromUrl(u) {
  const lu = norm(u);
  for (const r of RETAILERS) {
    for (const d of r.domains) {
      if (lu.includes(d)) return r.key;
    }
  }
  return "other";
}

function allowedRetailerUrl(u) {
  const lu = norm(u);
  return RETAILERS.some((r) => r.domains.some((d) => lu.includes(d)));
}

function looksLikeBadImage(imgUrl) {
  const lu = norm(imgUrl);
  if (!lu) return true;
  if (!(lu.includes(".jpg") || lu.includes(".jpeg") || lu.includes(".png") || lu.includes(".webp") || lu.includes("hmgoepprod"))) {
    // allow hmgoepprod even without extension
    return true;
  }
  return BAD_IMAGE_HINTS.some((x) => lu.includes(x));
}

function isHotWheelsApparelPage(html, url) {
  const h = norm(html);
  const u = norm(url);

  const hasLicense = h.includes("hot wheels") || u.includes("hot-wheels") || u.includes("hotwheels");
  if (!hasLicense) return false;

  const hasApparel = APPAREL_TERMS.some((t) => h.includes(t) || u.includes(t.replace(/\s+/g, "-")));
  return hasApparel;
}

async function fetchText(url, { timeoutMs = 20000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);

      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "en-GB,en;q=0.9" },
        signal: ctrl.signal,
      });
      clearTimeout(t);

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
  return "";
}

function extractOgImage(html) {
  // property="og:image" content="..."
  const m1 = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (m1?.[1]) return m1[1];

  // name="twitter:image" content="..."
  const m2 = html.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (m2?.[1]) return m2[1];

  // sometimes og:image appears with content first
  const m3 = html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (m3?.[1]) return m3[1];

  return "";
}

function parseDuckDuckGoHtmlResults(html) {
  // DDG HTML uses links like: <a rel="nofollow" class="result__a" href="...">
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1];
    // Sometimes DDG wraps links with /l/?uddg=<encoded>
    try {
      const u = new URL(href, "https://duckduckgo.com");
      const uddg = u.searchParams.get("uddg");
      if (uddg) href = decodeURIComponent(uddg);
      else href = u.toString();
    } catch {}
    out.push(href);
  }
  return out;
}

async function ddgSearch(query) {
  const q = encodeURIComponent(query);
  const url = `https://duckduckgo.com/html/?q=${q}`;
  const html = await fetchText(url);
  return parseDuckDuckGoHtmlResults(html);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function dedupeItems(items) {
  const seenUrl = new Set();
  const seenImg = new Set();
  const out = [];

  for (const it of items) {
    const pu = stripQuery(it.product_url);
    const iu = stripQuery(it.image_url);

    // Dedupe by product URL
    if (seenUrl.has(pu)) continue;

    // Dedupe by image filename (helps for same product with multiple URLs)
    const imgKey = (() => {
      try {
        const u = new URL(iu);
        const base = u.pathname.split("/").pop() || iu;
        return base.toLowerCase();
      } catch {
        return iu.toLowerCase();
      }
    })();

    if (seenImg.has(imgKey)) continue;

    seenUrl.add(pu);
    seenImg.add(imgKey);
    out.push(it);
  }
  return out;
}

async function collectFromSearch() {
  const queries = [];

  // Wider net BUT still “Hot Wheels + apparel”
  for (const r of RETAILERS) {
    // Pinterest is good for variety, but needs filtering
    const siteHint =
      r.key === "pinterest"
        ? "site:pinterest.com pin hot wheels hoodie"
        : `site:${r.domains.find(d => !d.includes(".")) ? r.domains[0] : r.domains[0]} "${LICENSE}"`;

    for (const t of ["hoodie", "t-shirt", "sweatshirt", "joggers", "pyjamas", "kids"]) {
      // Example: site:next.co.uk "hot wheels" hoodie
      const q = (r.key === "pinterest")
        ? `${LICENSE} ${t} site:pinterest.com`
        : `"${LICENSE}" ${t} ${siteHint.replace(`"${LICENSE}"`, "").trim()}`.trim();
      queries.push(q);
    }
  }

  const allCandidateUrls = [];
  for (const q of queries) {
    try {
      const urls = await ddgSearch(q);
      allCandidateUrls.push(...urls);
      await sleep(200);
    } catch {
      // ignore individual search failures
    }
  }

  // Keep only approved retailer domains (pins are product URLs; pinimg are images, not product pages)
  const candidates = uniq(allCandidateUrls)
    .map(u => u.replace(/^http:\/\//i, "https://")) // prefer https
    .filter(u => allowedRetailerUrl(u))
    .filter(u => !u.includes("pinimg.com")); // not a product page

  return candidates.slice(0, 400); // cap to reduce runtime
}

async function buildItemsFromProductPages(productUrls) {
  const items = [];

  for (const url of productUrls) {
    try {
      const html = await fetchText(url, { timeoutMs: 25000, retries: 1 });

      // Filter hard: must be Hot Wheels + apparel
      if (!isHotWheelsApparelPage(html, url)) continue;

      const img = extractOgImage(html);
      if (!img) continue;

      const imageUrl = img.startsWith("//") ? `https:${img}` : img;
      if (looksLikeBadImage(imageUrl)) continue;

      items.push({
        retailer: guessRetailerFromUrl(url),
        product_url: url,
        image_url: imageUrl,
      });

      // light throttle
      if (items.length % 10 === 0) await sleep(300);
    } catch {
      // ignore page failures (blocks/timeouts happen)
    }
  }

  return items;
}

async function main() {
  ensureDir(DATA_DIR);

  const previous = readJsonSafe(OUT_JSON);

  console.log(`[collector] Previous items: ${previous.length}`);

  // 1) find candidate product URLs
  console.log("[collector] Searching fallback domains (DDG HTML)...");
  const productUrls = await collectFromSearch();
  console.log(`[collector] Candidate product URLs: ${productUrls.length}`);

  // 2) fetch product pages and extract og:image
  console.log("[collector] Extracting product images from pages...");
  let items = await buildItemsFromProductPages(productUrls);

  // 3) cleanup + dedupe
  items = dedupeItems(items);

  // Keep only the retailers we support (no "other")
  items = items.filter(x => x.retailer !== "other");

  console.log(`[collector] New items after filtering: ${items.length}`);

  // 4) Never overwrite good data with empty/too small
  const MIN_OK = 20;
  if (items.length < MIN_OK && previous.length >= MIN_OK) {
    console.log(`[collector] Too few results (${items.length}). Keeping previous (${previous.length}).`);
    items = previous;
  }

  // 5) Write JSON
  writeJson(OUT_JSON, items);
  console.log(`[collector] Wrote: ${OUT_JSON} (${items.length} items)`);
}

main().catch((err) => {
  console.error("[collector] Fatal:", err);
  process.exit(1);
});
