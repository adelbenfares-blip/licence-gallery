import fs from "fs";

const OUT_PATH = "data/hot-wheels.json";
const DEBUG_DIR = "debug";
const MAX_ITEMS = 200;

const BRAND = "Hot Wheels";

// International variety allowed, so keep query broad but apparel-focused.
const QUERY_BASE = `"${BRAND}" kids (t-shirt OR tee OR hoodie OR sweatshirt OR joggers OR pyjamas OR pajamas)`;

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

// Multiple modest queries tends to give better coverage than one huge query.
const QUERIES = [
  { name: "General", q: QUERY_BASE },

  // Bias each retailer (Bing Images tends to respond better this way)
  { name: "Zara", q: `"${BRAND}" kids clothing site:zara.com` },
  { name: "H&M", q: `"${BRAND}" kids clothing site:hm.com` },
  { name: "Next", q: `"${BRAND}" kids clothing site:next.co.uk` },
  { name: "ASOS", q: `"${BRAND}" clothing site:asos.com` },
  { name: "Zalando", q: `"${BRAND}" clothing site:zalando.com` },
  { name: "BoxLunch", q: `"${BRAND}" shirt hoodie site:boxlunch.com` },
  { name: "PacSun", q: `"${BRAND}" shirt hoodie site:pacsun.com` },
  { name: "BucketsAndSpades", q: `"${BRAND}" kids hoodie site:bucketsandspades.com.au` },

  // Pinterest is noisy but valuable; we filter it.
  { name: "Pinterest", q: `"${BRAND}" kids hoodie site:pinterest.com` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  fs.mkdirSync("data", { recursive: true });
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

function logDebug(msg) {
  ensureDirs();
  fs.appendFileSync(
    `${DEBUG_DIR}/run.txt`,
    `[${new Date().toISOString()}] ${msg}\n`,
    "utf-8"
  );
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
  const text = await res.text();
  return { status: res.status, text };
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

/**
 * One tile per "style" logic.
 * Tries to extract a stable product identifier per retailer.
 */
function styleKey(retailer, productUrl) {
  const u = stripQueryHash(productUrl || "");

  // H&M: /productpage.1210905001.html => 1210905001
  if (retailer === "hm") {
    const m = u.match(/productpage\.(\d+)\.html/i);
    if (m?.[1]) return `hm:${m[1]}`;
  }

  // Next: /style/su472310/aj0465 OR /style/su242624/980517
  if (retailer === "next") {
    const m = u.match(/\/style\/[^/]+\/([^/?#]+)/i);
    if (m?.[1]) return `next:${m[1].toLowerCase()}`;
  }

  // Zara: common patterns include p########.html or /product/########
  if (retailer === "zara") {
    const m1 = u.match(/p(\d+)\.html/i);
    if (m1?.[1]) return `zara:p${m1[1]}`;
    const m2 = u.match(/\/product\/(\d+)/i);
    if (m2?.[1]) return `zara:${m2[1]}`;
  }

  // ASOS: /prd/######## or productid=########
  if (retailer === "asos") {
    const m1 = u.match(/\/prd\/(\d+)/i);
    if (m1?.[1]) return `asos:${m1[1]}`;
    const m2 = u.match(/productid=(\d+)/i);
    if (m2?.[1]) return `asos:${m2[1]}`;
  }

  // Zalando: use normalized path
  if (retailer === "zalando") {
    try {
      const urlObj = new URL(u);
      return `zalando:${urlObj.pathname.toLowerCase()}`;
    } catch {}
  }

  // BoxLunch: often has /product/... or /product/<name>/<id>. Keep pathname.
  if (retailer === "boxlunch") {
    try {
      const urlObj = new URL(u);
      return `boxlunch:${urlObj.pathname.toLowerCase()}`;
    } catch {}
  }

  // PacSun: keep pathname
  if (retailer === "pacsun") {
    try {
      const urlObj = new URL(u);
      return `pacsun:${urlObj.pathname.toLowerCase()}`;
    } catch {}
  }

  // Buckets & Spades: keep pathname
  if (retailer === "bucketsandspades") {
    try {
      const urlObj = new URL(u);
      return `bucketsandspades:${urlObj.pathname.toLowerCase()}`;
    } catch {}
  }

  // Pinterest: pin id
  if (retailer === "pinterest") {
    const m = u.match(/\/pin\/([^/]+)/i);
    if (m?.[1]) return `pinterest:${m[1]}`;
  }

  return `${retailer}:${u.toLowerCase()}`;
}

/**
 * Prefer higher quality images when multiple images exist for a style.
 */
function imageScore(imageUrl) {
  const s = (imageUrl || "").toLowerCase();
  let score = 0;

  if (s.includes("original")) score += 4;
  if (s.includes("2160") || s.includes("imwidth=2160")) score += 3;
  if (s.includes("1600") || s.includes("1500")) score += 2;
  if (s.includes("1260") || s.includes("imwidth=1260")) score += 2;
  if (s.includes("750") || s.includes("width=750")) score += 1;

  if (s.includes("thumb")) score -= 2;
  if (s.includes("thumbnail")) score -= 2;
  if (s.includes("th?id=")) score -= 1;

  if (s.endsWith(".jpg") || s.includes(".jpg?")) score += 1;

  return score;
}

/**
 * Keep results relevant; Pinterest is the noisiest.
 * We allow international variety, but still enforce brand+apparel hints.
 */
function looksLikeHotWheelsApparel(productUrl, imageUrl) {
  const s = `${productUrl} ${imageUrl}`.toLowerCase();

  const hasBrand =
    s.includes("hot-wheels") ||
    s.includes("hotwheels") ||
    (s.includes("hot") && s.includes("wheels"));

  const apparelHints = [
    "tshirt","t-shirt","tee",
    "hoodie","sweatshirt","crewneck","jumper","fleece",
    "jogger","joggers","pants","trouser","tracksuit",
    "pyjama","pajama","sleep","set",
    "shirt","top",
    "kids","boys","girls","teen","youth",
  ];
  const hasApparel = apparelHints.some((k) => s.includes(k));

  return hasBrand && hasApparel;
}

/**
 * Parse Bing Images embedded JSON blobs from attribute m="...".
 * We want:
 *   obj.purl (click-through page)
 *   obj.murl/imgurl (image URL)
 */
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

    if (image_url && product_url) {
      results.push({ product_url, image_url });
    }
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

    logDebug(`BING IMAGES [${label}] page=${page} first=${first} url=${url}`);

    const { status, text: html } = await fetchText(url);
    logDebug(`BING IMAGES [${label}] status=${status} chars=${html.length}`);

    writeDebugFile(`bing_images_${label}_${page}.html`, html.slice(0, 250000));

    const items = parseBingImages(html);
    logDebug(`BING IMAGES [${label}] parsed items: ${items.length}`);

    if (items.length === 0) break;

    for (const it of items) {
      const retailer = normalizeRetailer(it.product_url);
      if (!retailer) {
        processed.push({ action: "SKIP_DOMAIN", retailer: null, ...it });
        continue;
      }

      // Filter Pinterest more strictly than “real retailers”
      if (retailer === "pinterest" && !looksLikeHotWheelsApparel(it.product_url, it.image_url)) {
        processed.push({ action: "SKIP_PINTEREST_NOISE", retailer, ...it });
        continue;
      }

      // For others, still apply relevance to reduce random results
      if (retailer !== "pinterest" && !looksLikeHotWheelsApparel(it.product_url, it.image_url)) {
        processed.push({ action: "SKIP_WEAK_MATCH", retailer, ...it });
        continue;
      }

      candidates.push({ retailer, product_url: it.product_url, image_url: it.image_url });
      processed.push({ action: "CANDIDATE", retailer, ...it });

      // Don’t blow up runtime; we’ll dedupe down later
      if (candidates.length > MAX_ITEMS * 6) break;
    }

    if (candidates.length > MAX_ITEMS * 6) break;

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
    if (!existing) {
      map.set(key, { ...it, _score: score });
      continue;
    }

    if (score > existing._score) {
      map.set(key, { ...it, _score: score });
    }
  }

  return Array.from(map.values()).map(({ _score, ...rest }) => rest);
}

async function main() {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/run.txt`, "", "utf-8");
  logDebug("Bing Images collector starting");

  const allCandidates = [];
  const allProcessed = [];

  for (const q of QUERIES) {
    const { processed, candidates } = await collectBingImagesForQuery(q.q, q.name, 5);

    allProcessed.push({ query: q.name, candidates: candidates.length });
    allProcessed.push(...processed);

    allCandidates.push(...candidates);

    // Early stop if we have plenty; dedupe will reduce it.
    if (allCandidates.length > MAX_ITEMS * 8) break;
  }

  writeDebugFile("processed.json", JSON.stringify(allProcessed.slice(0, 4000), null, 2));

  // Quick dedupe by image first (cheap)
  const quick = (() => {
    const seen = new Set();
    return allCandidates.filter((it) => {
      const key = it.image_url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();

  // Strong dedupe by style (one tile per product/style; keep best image)
  const styleDedupe = dedupeByStyleKeepBest(quick);

  // Final cap
  const final = styleDedupe.slice(0, MAX_ITEMS);

  fs.writeFileSync(OUT_PATH, JSON.stringify(final, null, 2), "utf-8");

  logDebug(`Candidates collected: ${allCandidates.length}`);
  logDebug(`After quick image dedupe: ${quick.length}`);
  logDebug(`After style dedupe: ${styleDedupe.length}`);
  logDebug(`Finished. Total items written: ${final.length}`);

  console.log(`Finished. Total items written: ${final.length}`);
}

main().catch((e) => {
  logDebug(`Fatal error: ${String(e)}`);
  console.error(e);
  process.exit(1);
});
