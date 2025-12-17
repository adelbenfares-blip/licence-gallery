import fs from "fs";

const OUT_PATH = "data/hot-wheels.json";
const DEBUG_DIR = "debug";
const MAX_ITEMS = 200;

// Strong intent queries (quoted brand + apparel)
const SOURCES = [
  {
    name: "Retailers",
    query:
      `"Hot Wheels" kids (t-shirt OR tee OR hoodie OR sweatshirt OR joggers OR pyjamas) ` +
      `site:next.co.uk OR site:hm.com OR site:zara.com OR site:asos.com OR site:zalando.co.uk`,
    tag: "retail",
  },
  {
    name: "Pinterest",
    query: `"Hot Wheels" kids (t-shirt OR tee OR hoodie OR sweatshirt OR joggers) site:pinterest.com`,
    tag: "pinterest",
  },
];

// Only include items where the *click-through URL* is one of these domains
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
  return null; // unknown domains dropped
}

function dedupe(list) {
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
  // attrName="value" or attrName='value'
  const re = new RegExp(`${attrName}=["']([^"']+)["']`, "i");
  const m = tagText.match(re);
  return m?.[1] ? decodeXml(m[1]) : null;
}

function parseBingRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const all = xml.match(itemRe) || [];

  for (const itemXml of all) {
    const linkRaw = extractBetween(itemXml, "<link>", "</link>");
    const product_url = linkRaw ? decodeXml(linkRaw.trim()) : null;

    // Try media:thumbnail first
    let image_url = null;

    const thumbTag = itemXml.match(/<media:thumbnail\b[^>]*>/i)?.[0];
    if (thumbTag) image_url = extractAttr(thumbTag, "url");

    // Try media:content
    if (!image_url) {
      const contentTag = itemXml.match(/<media:content\b[^>]*>/i)?.[0];
      if (contentTag) image_url = extractAttr(contentTag, "url");
    }

    // Try enclosure url=""
    if (!image_url) {
      const encTag = itemXml.match(/<enclosure\b[^>]*>/i)?.[0];
      if (encTag) image_url = extractAttr(encTag, "url");
    }

    // Try <description> containing <img src="...">
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
      logDebug(`Source "${src.name}" rss items with images: ${rssItems.length}`);
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

    // tiny delay between sources
    await sleep(200);
  }

  writeDebugFile("processed.json", JSON.stringify(processed.slice(0, 500), null, 2));

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
