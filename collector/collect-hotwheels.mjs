import fs from "fs";

const OUT_PATH = "data/hot-wheels.json";
const DEBUG_DIR = "debug";
const MAX_ITEMS = 200;

// IMPORTANT: Bing RSS is picky. Keep queries SIMPLE (one site per query).
const SOURCES = [
  { name: "Next", query: `"Hot Wheels" site:next.co.uk`, tag: "next" },
  { name: "H&M", query: `"Hot Wheels" site:hm.com`, tag: "hm" },
  { name: "Zara", query: `"Hot Wheels" site:zara.com`, tag: "zara" },
  { name: "ASOS", query: `"Hot Wheels" site:asos.com`, tag: "asos" },
  { name: "Zalando", query: `"Hot Wheels" site:zalando.co.uk`, tag: "zalando" },
  { name: "Pinterest", query: `"Hot Wheels" site:pinterest.com`, tag: "pinterest" },
];

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

function decodeXml(s) {
  return (s || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function normalizeRetailer(url) {
  const u = (url || "").toLowerCase();
  for (const r of ALLOWED_RETAILER_MATCH) {
    if (r.match.some((m) => u.includes(m))) return r.key;
  }
  return null;
}

function dedupe(list) {
  // Dedupe by (retailer + product_url)
  const map = new Map();
  for (const item of list) {
    if (!item?.retailer || !item?.product_url || !item?.image_url) continue;
    map.set(`${item.retailer}::${item.product_url}`, item);
  }
  return Array.from(map.values());
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
      "accept-language": "en-GB,en;q=0.9",
    },
  });

  const text = await res.text();
  return { status: res.status, text };
}

function extractBetween(s, startTag, endTag) {
  const start = s.indexOf(startTag);
  if (start === -1) return null;
  const end = s.indexOf(endTag, start + startTag.length);
  if (end === -1) return null;
  return s.slice(start + startTag.length, end);
}

function extractAttr(tagText, attrName) {
  const re = new RegExp(`${attrName}=["']([^"']+)["']`, "i");
  const m = tagText.match(re);
  return m?.[1] ? decodeXml(m[1]) : null;
}

function parseBingRssItems(xml) {
  // Return [{ product_url, image_url }]
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const all = xml.match(itemRe) || [];

  for (const itemXml of all) {
    const linkRaw = extractBetween(itemXml, "<link>", "</link>");
    const product_url = linkRaw ? decodeXml(linkRaw.trim()) : null;

    let image_url = null;

    // 1) <media:thumbnail url="..."/>
    const thumbTag = itemXml.match(/<media:thumbnail\b[^>]*>/i)?.[0];
    if (thumbTag) image_url = extractAttr(thumbTag, "url");

    // 2) <media:content url="..."/>
    if (!image_url) {
      const contentTag = itemXml.match(/<media:content\b[^>]*>/i)?.[0];
      if (contentTag) image_url = extractAttr(contentTag, "url");
    }

    // 3) <enclosure url="..."/>
    if (!image_url) {
      const encTag = itemXml.match(/<enclosure\b[^>]*>/i)?.[0];
      if (encTag) image_url = extractAttr(encTag, "url");
    }

    // 4) <description> ... <img src="...">
    if (!image_url) {
      const desc = extractBetween(itemXml, "<description>", "</description>");
      if (desc) {
        const m = decodeXml(desc).match(/<img[^>]+src=["']([^"']+)["']/i);
        if (m?.[1]) image_url = m[1];
      }
    }

    if (product_url && image_url) {
      items.push({ product_url, image_url });
    }
  }

  return items;
}

async function collectFromBingRss(query, label) {
  const rssUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
  logDebug(`BING(${label}) RSS: ${rssUrl}`);

  const { status, text } = await fetchText(rssUrl);
  logDebug(`BING(${label}) status: ${status}`);

  // Keep full-ish RSS for debugging
  writeDebugFile(`bing_${label}.xml`, text.slice(0, 250000));

  return parseBingRssItems(text);
}

async function main() {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/run.txt`, "", "utf-8");
  logDebug("RSS-image collector starting");

  const collected = [];
  const processed = [];

  for (const src of SOURCES) {
    let rssItems = [];
    try {
      rssItems = await collectFromBingRss(src.query, src.tag);
      logDebug(`Source "${src.name}" items (link+image): ${rssItems.length}`);
    } catch (e) {
      logDebug(`Source "${src.name}" ERROR: ${String(e)}`);
      continue;
    }

    for (const it of rssItems) {
      const retailer = normalizeRetailer(it.product_url);

      if (!retailer) {
        processed.push({
          product_url: it.product_url,
          image_url: it.image_url,
          retailer: null,
          action: "SKIP_DOMAIN",
        });
        continue;
      }

      collected.push({
        retailer,
        product_url: it.product_url,
        image_url: it.image_url,
      });

      processed.push({
        product_url: it.product_url,
        image_url: it.image_url,
        retailer,
        action: "ADD",
      });

      if (collected.length >= MAX_ITEMS) break;
    }

    if (collected.length >= MAX_ITEMS) break;

    await sleep(150);
  }

  writeDebugFile("processed.json", JSON.stringify(processed, null, 2));

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
