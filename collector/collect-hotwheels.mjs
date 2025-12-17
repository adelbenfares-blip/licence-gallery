import fs from "fs";
import path from "path";
import crypto from "crypto";

const BRAND = "Hot Wheels";

const OUT_JSON = "data/hot-wheels.json";
const IMG_DIR = "images/hot-wheels";
const DEBUG_DIR = "debug";

const MAX_ITEMS = 200;

// Pull a lot more candidates, then dedupe down
const MAX_CANDIDATES = 4000;

// Bing paging
const PAGES_PER_QUERY = 18; // deeper = more results
const COUNT_PER_PAGE = 50;  // max Bing will usually accept

const RETAILERS = [
  { key: "zara", match: ["zara.com"] },
  { key: "hm", match: ["hm.com", "www2.hm.com"] },
  { key: "next", match: ["next.co.uk"] },
  { key: "asos", match: ["asos.com"] },
  { key: "zalando", match: ["zalando.co.uk", "zalando.com"] },
  { key: "pinterest", match: ["pinterest.com", "pinterest.co.uk", "pinterest.fr"] },
  { key: "boxlunch", match: ["boxlunch.com"] },
  { key: "pacsun", match: ["pacsun.com"] },
  { key: "bucketsandspades", match: ["bucketsandspades.com.au"] },
];

// More query variants = more coverage
const QUERIES = [
  `"${BRAND}" kids clothing`,
  `"${BRAND}" t-shirt kids`,
  `"${BRAND}" hoodie kids`,
  `"${BRAND}" sweatshirt kids`,
  `"${BRAND}" pyjamas kids`,

  `"${BRAND}" site:next.co.uk`,
  `"${BRAND}" site:hm.com`,
  `"${BRAND}" site:zara.com`,
  `"${BRAND}" site:asos.com`,
  `"${BRAND}" site:zalando.com`,
  `"${BRAND}" site:boxlunch.com`,
  `"${BRAND}" site:pacsun.com`,
  `"${BRAND}" site:bucketsandspades.com.au`,
  `"${BRAND}" kids site:pinterest.com`,
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

function normalizeRetailer(url) {
  const u = (url || "").toLowerCase();
  for (const r of RETAILERS) {
    if (r.match.some((m) => u.includes(m))) return r.key;
  }
  return null;
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

// Pinterest is noisy, so keep it strict. Real retailers: accept if domain matches.
function pinterestLooksRelevant(productUrl, imageUrl) {
  const s = `${productUrl} ${imageUrl}`.toLowerCase();
  const hasBrand =
    s.includes("hot-wheels") || s.includes("hotwheels") || (s.includes("hot") && s.includes("wheels"));
  const apparelHints = ["tshirt","t-shirt","tee","hoodie","sweatshirt","jumper","jogger","joggers","pyjama","pajama","shirt","top","set"];
  return hasBrand && apparelHints.some((k) => s.includes(k));
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

  try {
    const urlObj = new URL(u);
    return `${retailer}:${urlObj.pathname.toLowerCase()}`;
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
  if (s.endsWith(".jpg") || s.includes(".jpg?") || s.endsWith(".png") || s.includes(".png?")) score += 1;
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
  const candidates = [];

  let first = 0;
  for (let page = 0; page < PAGES_PER_QUERY; page++) {
    const url =
      `https://www.bing.com/images/search?q=${encodeURIComponent(query)}` +
      `&first=${first}&count=${COUNT_PER_PAGE}&form=HDRSC2`;

    logDebug(`BING q${qIndex} page=${page} first=${first}`);
    const { status, text: html } = await fetchText(url);
    logDebug(`BING q${qIndex} status=${status} chars=${html.length}`);

    writeDebugFile(`bing_q${qIndex}_p${page}.html`, html.slice(0, 200000));

    const items = parseBingImages(html);
    logDebug(`BING q${qIndex} parsed=${items.length}`);
    if (items.length === 0) break;

    for (const it of items) {
      const retailer = normalizeRetailer(it.product_url);
      if (!retailer) continue;

      if (retailer === "pinterest" && !pinterestLooksRelevant(it.product_url, it.image_url)) continue;

      candidates.push({ retailer, product_url: it.product_url, image_url: it.image_url });
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }

    first += COUNT_PER_PAGE;
    await sleep(250);
  }

  return candidates;
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

  if (fs.existsSync(abs)) return `./${rel}`;

  // Try fetch with referer set to product page (helps some CDNs)
  const res = await fetch(imageUrl, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      referer: productUrl || "https://www.bing.com/",
    },
  });

  if (!res.ok) {
    logDebug(`IMG FAIL ${res.status} ${imageUrl}`);
    return null;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  // Skip tiny “blocked” responses
  if (buf.length < 2000) {
    logDebug(`IMG TINY ${buf.length} ${imageUrl}`);
    return null;
  }

  fs.writeFileSync(abs, buf);
  return `./${rel}`;
}

async function main() {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/run.txt`, "", "utf-8");
  logDebug("Collector start");

  // 1) Collect lots of candidates
  let all = [];
  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    const got = await collectFromBing(q, i);
    logDebug(`Query ${i} got ${got.length}`);
    all = all.concat(got);
    if (all.length >= MAX_CANDIDATES) break;
  }

  logDebug(`Total raw candidates: ${all.length}`);

  // 2) Quick image-url dedupe
  {
    const seen = new Set();
    all = all.filter((x) => {
      if (seen.has(x.image_url)) return false;
      seen.add(x.image_url);
      return true;
    });
  }

  // 3) Style dedupe (one per product)
  const deduped = dedupeByStyleKeepBest(all);
  logDebug(`After style dedupe: ${deduped.length}`);

  // 4) Download images locally + write final JSON
  const final = [];
  for (const item of deduped) {
    if (final.length >= MAX_ITEMS) break;
    const local = await downloadImage(item.image_url, item.product_url);
    if (!local) continue;

    final.push({
      retailer: item.retailer,
      product_url: item.product_url,
      image_url: local, // LOCAL PATH now
    });
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(final, null, 2), "utf-8");
  logDebug(`Final written: ${final.length}`);
  console.log(`Finished. Total items written: ${final.length}`);
}

main().catch((e) => {
  logDebug(`Fatal error: ${String(e)}`);
  console.error(e);
  process.exit(1);
});
