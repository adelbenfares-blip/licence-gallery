import fs from "fs";

const OUT_PATH = "data/hot-wheels.json";
const DEBUG_DIR = "debug";
const MAX_ITEMS = 200;

// We deliberately quote "Hot Wheels" and force apparel intent,
// and we exclude common “dictionary/definition” noise.
const SOURCES = [
  {
    name: "Retail apparel",
    query:
      `"Hot Wheels" kids clothing t-shirt hoodie sweatshirt joggers pyjamas ` +
      `-dictionary -definition -meaning -merriam -cambridge -wordreference -wikipedia`,
    tag: "retailer",
  },
  {
    name: "Pinterest discovery",
    query: `"Hot Wheels" kids clothing t-shirt hoodie site:pinterest.com`,
    tag: "pinterest",
  },
];

// Domains we allow into the gallery.
// Add more retailers here as you expand.
const ALLOWED_RETAILER_MATCH = [
  { key: "next", match: ["next.co.uk"] },
  { key: "hm", match: ["hm.com", "www2.hm.com"] },
  { key: "zara", match: ["zara.com"] },
  { key: "asos", match: ["asos.com"] },
  { key: "zalando", match: ["zalando.co.uk", "zalando.com"] },
  { key: "pinterest", match: ["pinterest.com", "pinterest.co.uk", "pinterest.fr"] },
];

// Optional global blocklist to avoid obvious non-product pages
const URL_BLOCKLIST_SUBSTR = [
  "dictionary",
  "definition",
  "wordreference",
  "merriam-webster",
  "cambridge.org/dictionary",
  "thefreedictionary",
  "wikipedia.org",
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

function dedupe(list) {
  const map = new Map();
  for (const item of list) {
    if (!item?.image_url || !item?.product_url || !item?.retailer) continue;
    map.set(`${item.retailer}::${item.product_url}`, item);
  }
  return Array.from(map.values());
}

function normalizeRetailer(url) {
  const u = url.toLowerCase();

  for (const r of ALLOWED_RETAILER_MATCH) {
    if (r.match.some((m) => u.includes(m))) return r.key;
  }
  return null; // IMPORTANT: unknown domains are dropped
}

function isBlockedUrl(url) {
  const u = url.toLowerCase();
  return URL_BLOCKLIST_SUBSTR.some((bad) => u.includes(bad));
}

function extractMeta(html, propertyOrName) {
  const reProp = new RegExp(
    `<meta[^>]+property=["']${propertyOrName}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m1 = html.match(reProp);
  if (m1?.[1]) return m1[1];

  const reName = new RegExp(
    `<meta[^>]+name=["']${propertyOrName}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m2 = html.match(reName);
  if (m2?.[1]) return m2[1];

  return null;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "";
}

function parseBingRssLinks(xml) {
  const links = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const linkRe = /<link>([\s\S]*?)<\/link>/i;

  const items = xml.match(itemRe) || [];
  for (const item of items) {
    const lm = item.match(linkRe);
    if (!lm) continue;
    const url = lm[1].trim();
    if (url.startsWith("http")) links.push(url);
  }
  return Array.from(new Set(links));
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-GB,en;q=0.9",
    },
  });

  const text = await res.text();
  return { status: res.status, text };
}

async function collectFromBingRss(query, label) {
  const rssUrl = `https://www.bing.com/search?q=${encodeURIComponent(
    query
  )}&format=rss`;

  logDebug(`BING(${label}) RSS: ${rssUrl}`);

  const { status, text: rss } = await fetchText(rssUrl);
  logDebug(`BING(${label}) RSS status: ${status}`);

  // keep a copy for debugging
  writeDebugFile(`bing_${label}.xml`, rss.slice(0, 250000));

  return parseBingRssLinks(rss);
}

async function resolveUrlToImage(url) {
  const { status, text: html } = await fetchText(url);

  const ogImage =
    extractMeta(html, "og:image") ||
    extractMeta(html, "twitter:image") ||
    extractMeta(html, "image");

  const title = extractTitle(html);

  return { status, ogImage, title };
}

async function main() {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/run.txt`, "", "utf-8");
  logDebug("Feed-based collector starting");

  const collected = [];
  const processedLog = [];

  // 1) Get candidate URLs from Bing RSS
  let candidateUrls = [];
  for (const src of SOURCES) {
    try {
      const urls = await collectFromBingRss(src.query, src.tag);
      candidateUrls.push(...urls);
      logDebug(`Source "${src.name}" URLs: ${urls.length}`);
    } catch (e) {
      logDebug(`Source "${src.name}" ERROR: ${String(e)}`);
    }
  }

  candidateUrls = Array.from(new Set(candidateUrls)).filter(
    (u) => !isBlockedUrl(u)
  );

  // 2) Resolve each URL to og:image
  const maxToProcess = Math.min(candidateUrls.length, 350);

  for (let i = 0; i < maxToProcess; i++) {
    const url = candidateUrls[i];

    const retailer = normalizeRetailer(url);
    if (!retailer) {
      // Drop unknown domains entirely (prevents dictionary/random sites)
      processedLog.push({ url, retailer: null, status: "SKIP_DOMAIN", hasImage: false });
      continue;
    }

    try {
      const { status, ogImage, title } = await resolveUrlToImage(url);

      const hasImage = !!ogImage;
      processedLog.push({
        url,
        retailer,
        status,
        hasImage,
        title: title.slice(0, 120),
      });

      if (ogImage) {
        collected.push({
          retailer,
          product_url: url,
          image_url: ogImage,
        });
      }
    } catch (e) {
      processedLog.push({ url, retailer, status: "ERR", hasImage: false });
    }

    // small delay reduces rate-limits
    await sleep(200);

    if (collected.length >= MAX_ITEMS) break;
  }

  writeDebugFile("processed.json", JSON.stringify(processedLog, null, 2));

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
