import fs from "fs";
import path from "path";
import crypto from "crypto";

const BRAND = "Hot Wheels";

const OUT_JSON = "data/hot-wheels.json";
const IMG_DIR = "images/hot-wheels";
const DEBUG_DIR = "debug";

const MAX_ITEMS = 200;

// Bing paging (more depth = more coverage)
const PAGES_PER_QUERY = 28;
const COUNT_PER_PAGE = 50;

// Cap per retailer so "other" / Pinterest doesn't dominate
const PER_RETAILER_CAP = {
  other: 140,
  pinterest: 60,
  zara: 120,
  hm: 120,
  next: 120,
  asos: 120,
  zalando: 120,
  boxlunch: 120,
  pacsun: 120,
  bucketsandspades: 120,
};

// Known retailers (classification)
const RETAILERS = [
  { key: "zara", match: ["zara.com"] },
  { key: "hm", match: ["hm.com", "www2.hm.com", "lp2.hm.com", "image.hm.com"] },
  { key: "next", match: ["next.co.uk", "xcdn.next.co.uk"] },
  { key: "asos", match: ["asos.com"] },
  { key: "zalando", match: ["zalando.co.uk", "zalando.com"] },
  { key: "pinterest", match: ["pinterest.com", "pinimg.com"] },
  { key: "boxlunch", match: ["boxlunch.com"] },
  { key: "pacsun", match: ["pacsun.com"] },
  { key: "bucketsandspades", match: ["bucketsandspades.com.au"] },
];

// Apparel intent keywords (for OTHER-domain filtering)
const APPAREL_TERMS = [
  "tshirt", "t-shirt", "tee", "shirt", "top",
  "hoodie", "sweatshirt", "jumper", "sweater",
  "jogger", "joggers", "tracksuit", "set",
  "pyjama", "pyjamas", "pajama", "pajamas",
  "jacket", "coat", "pants", "trousers", "shorts",
  "cap", "hat", "beanie",
  "kids", "boy", "boys", "girl", "girls", "toddler", "baby"
];

// Queries: retailer-specific + broad apparel intent
const QUERIES = [
  // retailer constrained
  `"${BRAND}" site:next.co.uk`,
  `"${BRAND}" site:hm.com`,
  `"${BRAND}" site:zara.com`,
  `"${BRAND}" site:asos.com`,
  `"${BRAND}" site:zalando.com`,
  `"${BRAND}" site:boxlunch.com`,
  `"${BRAND}" site:pacsun.com`,
  `"${BRAND}" site:bucketsandspades.com.au`,
  `"${BRAND}" kids site:pinterest.com`,

  // broad but still apparel intent
  `"${BRAND}" kids hoodie`,
  `"${BRAND}" kids sweatshirt`,
  `"${BRAND}" kids t-shirt`,
  `"${BRAND}" boys hoodie`,
  `"${BRAND}" boys sweatshirt`,
  `"${BRAND}" boys t-shirt`,
  `"${BRAND}" girls hoodie`,
  `"${BRAND}" girls sweatshirt`,
  `"${BRAND}" girls t-shirt`,
  `"${BRAND}" pyjamas`,
  `"${BRAND}" joggers`,
  `"${BRAND}" tracksuit`,
  `"${BRAND}" beanie`,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  fs.mkdirSync("data", { recursive: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

function logDebug(msg) {
  ensureDirs();
  fs.appendFileSync(`${DEBUG_DIR}/run.txt`, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
}

function writeDebugFile(name, content) {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/${name}`, content, "utf-8");
}

function htmlUnescape(s) {
  return (s || "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'");
}

function stripQueryHash(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

function normalizeRetailer(url) {
  const u = (url || "").toLowerCase();
  for (const r of RETAILERS) {
    if (r.match.some((m) => u.includes(m))) return r.key;
  }
  return "other"; // FALLBACK
}

function containsAny(haystack, needles) {
  const s = (haystack || "").toLowerCase();
  return needles.some((n) => s.includes(n));
}

// Keep Pinterest strict so it doesn't turn into random aesthetics
function pinterestLooksRelevant(productUrl, imageUrl) {
  const s = `${productUrl} ${imageUrl}`.toLowerCase();
  const hasBrand =
    s.includes("hot-wheels") || s.includes("hotwheels") || (s.includes("hot") && s.includes("wheels"));
  return hasBrand && containsAny(s, APPAREL_TERMS);
}

// Filter OTHER so we don’t ingest dictionary pages, logos, etc.
function otherLooksRelevant(productUrl, imageUrl) {
  const s = `${productUrl} ${imageUrl}`.toLowerCase();
  const hasBrand =
    s.includes("hot-wheels") || s.includes("hotwheels") || (s.includes("hot") && s.includes("wheels"));

  // must show apparel intent OR common ecommerce patterns
  const apparelIntent = containsAny(s, APPAREL_TERMS);
  const ecommerceHints = containsAny(s, [
    "/product", "/products", "product", "sku", "style", "item", "pid", "variant",
    "shop", "store", "cart"
  ]);

  // avoid obvious junk sources
  const junk = containsAny(s, [
    "wikipedia.org",
    "merriam-webster.com",
    "dictionary.",
    "cambridge.org/dictionary",
    "thefreedictionary.com",
    "wordreference.com",
    "fandom.com/wiki",
    "logo",
    "vector",
    "svg"
  ]);

  return hasBrand && (apparelIntent || ecommerceHints) && !junk;
}

function styleKey(retailer, productUrl) {
  const u = stripQueryHash(productUrl || "");

  if (retailer === "hm") {
    const m = u.match(/productpage\.(\d+)\.html/i);
    if (m?.[1]) return `hm:${m[1]}`;
  }

  if (retailer === "next") {
    const m = u.match(/\/style\/[^/]+\/([^/?#]+)/i);
    if (m?.[1]) return `next:${m[1].toLowerCase()}`;
  }

  if (retailer === "asos") {
    const m1 = u.match(/\/prd\/(\d+)/i);
    if (m1?.[1]) return `asos:${m1[1]}`;
    const m2 = u.match(/productid=(\d+)/i);
    if (m2?.[1]) return `asos:${m2[1]}`;
  }

  if (retailer === "zara") {
    const m1 = u.match(/p(\d+)\.html/i);
    if (m1?.[1]) return `zara:p${m1[1]}`;
    const m2 = u.match(/\/product\/(\d+)/i);
    if (m2?.[1]) return `zara:${m2[1]}`;
  }

  if (retailer === "pinterest") {
    const m = u.match(/\/pin\/([^/]+)/i);
    if (m?.[1]) return `pinterest:${m[1]}`;
  }

  // other: bucket by hostname+path
  try {
    const urlObj = new URL(u);
    return `${retailer}:${urlObj.hostname}${urlObj.pathname}`.toLowerCase();
  } catch {
    return `${retailer}:${u.toLowerCase()}`;
  }
}

function imageScore(imageUrl) {
  const s = (imageUrl || "").toLowerCase();
  let score = 0;
  if (s.includes("original")) score += 4;
  if (s.includes("2160") || s.includes("imwidth=2160")) score += 3;
  if (s.includes("1260") || s.includes("imwidth=1260")) score += 2;
  if (s.includes("750") || s.includes("width=750")) score += 1;
  if (s.includes("thumb") || s.includes("thumbnail")) score -= 2;
  if (s.endsWith(".jpg") || s.includes(".jpg?") || s.endsWith(".png") || s.includes(".png?") || s.includes("webp")) score += 1;
  return score;
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en,en-GB;q=0.9",
    },
  });
  return { status: res.status, text: await res.text() };
}

function parseBingImages(html) {
  const results = [];
  const re = /\sm="([^"]+)"/g;
  let match;

  while ((match = re.exec(html)) !== null) {
    const raw = match[1];
    const unescaped = htmlUnescape(raw);

    let obj = null;
    try {
      obj = JSON.parse(unescaped);
    } catch {
      continue;
    }

    const image_url = obj.murl || obj.imgurl || obj.turl || null;
    const product_url = obj.purl || null;

    if (image_url && product_url) results.push({ product_url, image_url });
  }
  return results;
}

async function collectFromBing(query, qIndex) {
  const out = [];
  let first = 0;

  for (let page = 0; page < PAGES_PER_QUERY; page++) {
    const url =
      `https://www.bing.com/images/search?q=${encodeURIComponent(query)}` +
      `&first=${first}&count=${COUNT_PER_PAGE}&form=HDRSC2`;

    const { status, text: html } = await fetchText(url);
    logDebug(`BING q${qIndex} page=${page} status=${status} chars=${html.length}`);
    writeDebugFile(`bing_q${qIndex}_p${page}.html`, html.slice(0, 120000));

    const items = parseBingImages(html);
    if (items.length === 0) break;

    for (const it of items) {
      const retailer = normalizeRetailer(it.product_url);

      if (retailer === "pinterest") {
        if (!pinterestLooksRelevant(it.product_url, it.image_url)) continue;
      } else if (retailer === "other") {
        if (!otherLooksRelevant(it.product_url, it.image_url)) continue;
      } else {
        // known retailer: still require brand presence somewhere (prevents random matches)
        const s = `${it.product_url} ${it.image_url}`.toLowerCase();
        const hasBrand =
          s.includes("hot-wheels") || s.includes("hotwheels") || (s.includes("hot") && s.includes("wheels"));
        if (!hasBrand) continue;
      }

      out.push({ retailer, product_url: it.product_url, image_url: it.image_url });
    }

    first += COUNT_PER_PAGE;
    await sleep(220);
  }

  return out;
}

function dedupeByStyleKeepBest(items) {
  const map = new Map();
  for (const it of items) {
    const key = styleKey(it.retailer, it.product_url);
    const score = imageScore(it.image_url);
    const existing = map.get(key);
    if (!existing || score > existing._score) map.set(key, { ...it, _score: score });
  }
  return Array.from(map.values()).map(({ _score, ...rest }) => rest);
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function extFromUrl(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith(".png")) return ".png";
    if (p.endsWith(".webp")) return ".webp";
    return ".jpg";
  } catch {
    return ".jpg";
  }
}

async function downloadImage(imageUrl, productUrl) {
  const id = sha1(imageUrl);
  const ext = extFromUrl(imageUrl);
  const rel = `${IMG_DIR}/${id}${ext}`;
  const abs = path.join(process.cwd(), rel);

  if (fs.existsSync(abs)) return `images/hot-wheels/${id}${ext}`;

  const res = await fetch(imageUrl, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      referer: productUrl || "https://www.bing.com/",
    },
  });

  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) return null;

  fs.writeFileSync(abs, buf);
  return `images/hot-wheels/${id}${ext}`;
}

function applyPerRetailerCap(items) {
  const counts = {};
  const out = [];

  for (const it of items) {
    const cap = PER_RETAILER_CAP[it.retailer] ?? 120;
    counts[it.retailer] = counts[it.retailer] ?? 0;
    if (counts[it.retailer] >= cap) continue;
    counts[it.retailer] += 1;
    out.push(it);
  }
  return out;
}

async function main() {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/run.txt`, "", "utf-8");
  logDebug("Collector start (other-domain fallback enabled)");

  // 1) Collect a lot of candidates
  let all = [];
  for (let i = 0; i < QUERIES.length; i++) {
    const got = await collectFromBing(QUERIES[i], i);
    logDebug(`Query ${i + 1}/${QUERIES.length} got=${got.length}`);
    all = all.concat(got);

    // stop once huge
    if (all.length > 9000) break;
  }

  logDebug(`Raw candidates total=${all.length}`);

  // 2) Deduplicate by image URL quickly
  {
    const seen = new Set();
    all = all.filter((x) => {
      if (seen.has(x.image_url)) return false;
      seen.add(x.image_url);
      return true;
    });
  }

  // 3) Dedupe by product/style
  let deduped = dedupeByStyleKeepBest(all);
  logDebug(`After style dedupe=${deduped.length}`);

  // 4) Prefer higher-res images first
  deduped.sort((a, b) => imageScore(b.image_url) - imageScore(a.image_url));

  // 5) Cap per retailer so "other" doesn't crush everything
  deduped = applyPerRetailerCap(deduped);

  // 6) Download images locally and build final output
  const final = [];
  for (const item of deduped) {
    if (final.length >= MAX_ITEMS) break;

    const local = await downloadImage(item.image_url, item.product_url);
    if (!local) continue;

    final.push({
      retailer: item.retailer,
      product_url: item.product_url,
      image_url: local, // local path
    });
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(final, null, 2), "utf-8");
  logDebug(`Final written=${final.length}`);
  console.log(`Finished. Items written: ${final.length}`);
}

main().catch((e) => {
  logDebug(`Fatal error: ${String(e)}`);
  console.error(e);
  process.exit(1);
});
