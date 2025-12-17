import fs from "fs";

const OUT_PATH = "data/hot-wheels.json";
const DEBUG_DIR = "debug";
const MAX_ITEMS = 200;

// Bing Images works far better for "image + click-through page"
const QUERY = `"Hot Wheels" kids t-shirt hoodie sweatshirt joggers pyjamas`;

const ALLOWED_RETAILER_MATCH = [
  { key: "next", match: ["next.co.uk"] },
  { key: "hm", match: ["hm.com", "www2.hm.com"] },
  { key: "zara", match: ["zara.com"] },
  { key: "asos", match: ["asos.com"] },
  { key: "zalando", match: ["zalando.co.uk", "zalando.com"] },
  { key: "pinterest", match: ["pinterest.com", "pinterest.co.uk", "pinterest.fr"] },
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

function normalizeRetailer(url) {
  const u = (url || "").toLowerCase();
  for (const r of ALLOWED_RETAILER_MATCH) {
    if (r.match.some((m) => u.includes(m))) return r.key;
  }
  return null;
}

function dedupe(list) {
  // Dedupe by image URL (best for galleries)
  const seen = new Set();
  return list.filter((it) => {
    if (!it?.retailer || !it?.product_url || !it?.image_url) return false;
    const key = it.image_url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-GB,en;q=0.9",
    },
  });

  const text = await res.text();
  return { status: res.status, text };
}

/**
 * Bing Images result items often include an attribute like:
 *   m="{&quot;imgurl&quot;:&quot;...&quot;,&quot;purl&quot;:&quot;...&quot;,...}"
 * or:
 *   m="{\"murl\":\"...\",\"purl\":\"...\",...}"
 *
 * We'll extract m="...".
 */
function parseBingImages(html) {
  const results = [];

  // Grab all m="..."; handles both double quotes and HTML-escaped quotes
  // We keep it intentionally broad; we'll JSON-parse what we can.
  const re = /\sm="([^"]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1];

    // Unescape common HTML entities inside attribute
    const unescaped = raw
      .replaceAll("&quot;", '"')
      .replaceAll("&#34;", '"')
      .replaceAll("&amp;", "&")
      .replaceAll("&#38;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">");

    // Some blobs are not JSON; skip those
    let obj = null;
    try {
      obj = JSON.parse(unescaped);
    } catch {
      continue;
    }

    // Bing uses various keys: murl/imgurl for image, purl for page
    const image_url = obj.murl || obj.imgurl || obj.turl || null;
    const product_url = obj.purl || null;

    if (image_url && product_url) {
      results.push({ product_url, image_url });
    }
  }

  return results;
}

async function collectBingImagesPages() {
  const collected = [];
  const processed = [];

  // Bing Images paging: first=0, 35, 70...
  // We'll keep going until MAX_ITEMS or no growth.
  let first = 0;
  let page = 0;

  while (collected.length < MAX_ITEMS && page < 12) {
    const url =
      `https://www.bing.com/images/search?q=${encodeURIComponent(QUERY)}` +
      `&first=${first}&count=35&form=HDRSC2`;

    logDebug(`BING IMAGES page=${page} first=${first} url=${url}`);

    const { status, text: html } = await fetchText(url);
    logDebug(`BING IMAGES status=${status} chars=${html.length}`);

    writeDebugFile(`bing_images_${page}.html`, html.slice(0, 250000));

    const items = parseBingImages(html);
    logDebug(`Parsed candidates (purl+murl): ${items.length}`);

    // If the page yields nothing, stop.
    if (items.length === 0) break;

    for (const it of items) {
      const retailer = normalizeRetailer(it.product_url);

      if (!retailer) {
        processed.push({
          retailer: null,
          action: "SKIP_DOMAIN",
          product_url: it.product_url,
          image_url: it.image_url,
        });
        continue;
      }

      collected.push({
        retailer,
        product_url: it.product_url,
        image_url: it.image_url,
      });

      processed.push({
        retailer,
        action: "ADD",
        product_url: it.product_url,
        image_url: it.image_url,
      });

      if (collected.length >= MAX_ITEMS) break;
    }

    // Move to next page
    first += 35;
    page += 1;
    await sleep(250);
  }

  return { collected, processed };
}

async function main() {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/run.txt`, "", "utf-8");
  logDebug("Bing Images collector starting");

  const { collected, processed } = await collectBingImagesPages();

  writeDebugFile("processed.json", JSON.stringify(processed.slice(0, 2000), null, 2));

  const final = dedupe(collected).slice(0, MAX_ITEMS);
  fs.writeFileSync(OUT_PATH, JSON.stringify(final, null, 2), "utf-8");

  logDebug(`Finished. Total items written: ${final.length}`);
  console.log(`Finished. Total items written: ${final.length}`);
}

main().catch((e) => {
  logDebug(`Fatal error: ${String(e)}`);
  console.error(e);
  process.exit(1);
});
