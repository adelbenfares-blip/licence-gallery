import fs from "fs";

const OUT_PATH = "data/hot-wheels.json";
const DEBUG_DIR = "debug";
const MAX_ITEMS = 200;

const BRAND = "Hot Wheels";

// Retailers you requested
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

// Bing Images queries (retailer-biased)
const QUERIES = [
  { name: "General", q: `"${BRAND}" kids clothing` },
  { name: "Zara", q: `"${BRAND}" site:zara.com` },
  { name: "H&M", q: `"${BRAND}" site:hm.com` },
  { name: "Next", q: `"${BRAND}" site:next.co.uk` },
  { name: "ASOS", q: `"${BRAND}" site:asos.com` },
  { name: "Zalando", q: `"${BRAND}" site:zalando.com` },
  { name: "BoxLunch", q: `"${BRAND}" site:boxlunch.com` },
  { name: "PacSun", q: `"${BRAND}" site:pacsun.com` },
  { name: "BucketsAndSpades", q: `"${BRAND}" site:bucketsandspades.com.au` },
  { name: "Pinterest", q: `"${BRAND}" kids hoodie site:pinterest.com` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  fs.mkdirSync("data", { recursive: true });
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

// Dedupe-by-style key (one tile per product/style)
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

  if (retailer === "zara") {
    const m1 = u.match(/p(\d+)\.html/i);
    if (m1?.[1]) return `zara:p${m1[1]}`;
    const m2 = u.match(/\/product\/(\d+)/i);
    if (m2?.[1]) return `zara:${m2[1]}`;
  }

  if (retailer === "asos") {
    const m1 = u.match(/\/prd\/(\d+)/i);
    if (m1?.[1]) return `asos:${m1[1]}`;
    const m2 = u.match(/productid=(\d+)/i);
    if (m2?.[1]) return `asos:${m2[1]}`;
  }

  if (retailer === "pinterest") {
    const m = u.match(/\/pin\/([^/]+)/i);
    if (m?.[1]) return `pinterest:${m[1]}`;
  }

  // Default: per-retailer pathname
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
  if (s.endsWith(".jpg") || s.includes(".jpg?")) score += 1;
  return score;
}

// Pinterest-only relevance check (keep it simple + strict)
function pinterestLooksRelevant(productUrl, imageUrl) {
  const s = `${productUrl} ${imageUrl}`.toLowerCase();
  const hasBrand =
    s.includes("hot-wheels") || s.includes("hotwheels") || (s.includes("hot") && s.includes("wheels"));
  const apparelHints = ["tshirt","t-shirt","tee","hoodie","sweatshirt","jumper","jogger","joggers","pyjama","pajama","shirt","top","set"];
  const hasApparel = apparelHints.some((k) => s.includes(k));
  return hasBrand && hasApparel;
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

async function collectBingImagesForQuery(query, label, pageLimit = 5) {
  const processed = [];
  const candidates = [];

  let first = 0;

  for (let page = 0; page < pageLimit; page++) {
    const url =
      `https://www.bing.com/images/search?q=${encodeURIComponent(query)}` +
      `&first=${first}&count=35&form=HDRSC2`;

    logDebug(`BING [${label}] page=${page} first=${first}`);
    const { status, text: html } = await fetchText(url);
    logDebug(`BING [${label}] status=${status} chars=${html.length}`);

    writeDebugFile(`bing_${label}_${page}.html`, html.slice(0, 250000));

    const items = parseBingImages(html);
    logDebug(`BING [${label}] parsed=${items.length}`);

    if (items.length === 0) break;

    for (const it of items) {
      const retailer = normalizeRetailer(it.product_url);

      if (!retailer) {
        processed.push({ action: "SKIP_DOMAIN", retailer: null, ...it });
        continue;
      }

      // Only Pinterest gets strict relevance filtering
      if (retailer === "pinterest" && !pinterestLooksRelevant(it.product_url, it.image_url)) {
        processed.push({ action: "SKIP_PINTEREST_NOISE", retailer, ...it });
        continue;
      }

      candidates.push({ retailer, product_url: it.product_url, image_url: it.image_url });
      processed.push({ action: "CANDIDATE", retailer, ...it });

      if (candidates.length > MAX_ITEMS * 10) break;
    }

    if (candidates.length > MAX_ITEMS * 10) break;

    first += 35;
    await sleep(250);
  }

  return { processed, candidates };
}

function dedupeByStyleKeepBest(items) {
  const map = new Map();

  for (const it of items) {
    if (!it?.retailer || !it?.product_url || !it?.image_url) continue;

    const key = styleKey(it.retailer, it.product_url);
    const score = imageScore(it.image_url);

    const existing = map.get(key);
    if (!existing || score > existing._score) {
      map.set(key, { ...it, _score: score });
    }
  }

  return Array.from(map.values()).map(({ _score, ...rest }) => rest);
}

async function main() {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/run.txt`, "", "utf-8");
  logDebug("Collector start");

  const allCandidates = [];
  const allProcessed = [];

  for (const q of QUERIES) {
    const { processed, candidates } = await collectBingImagesForQuery(q.q, q.name, 5);

    allProcessed.push({ query: q.name, candidates: candidates.length });
    allProcessed.push(...processed);
    allCandidates.push(...candidates);

    if (allCandidates.length > MAX_ITEMS * 12) break;
  }

  writeDebugFile("processed.json", JSON.stringify(allProcessed.slice(0, 5000), null, 2));

  // quick image dedupe
  const quick = (() => {
    const seen = new Set();
    return allCandidates.filter((it) => {
      const k = it.image_url;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  })();

  const styleDedupe = dedupeByStyleKeepBest(quick);
  const final = styleDedupe.slice(0, MAX_ITEMS);

  fs.writeFileSync(OUT_PATH, JSON.stringify(final, null, 2), "utf-8");

  logDebug(`Candidates=${allCandidates.length} quick=${quick.length} style=${styleDedupe.length} final=${final.length}`);
  console.log(`Finished. Total items written: ${final.length}`);
}

main().catch((e) => {
  logDebug(`Fatal error: ${String(e)}`);
  console.error(e);
  process.exit(1);
});
