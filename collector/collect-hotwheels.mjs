import fs from "fs";

const OUT_PATH = "data/hot-wheels.json";
const DEBUG_DIR = "debug";
const LICENSE_QUERY = "hot wheels";
const MAX_ITEMS = 200;

// Add/remove sources here
const SOURCES = [
  {
    name: "Retailers (via Bing)",
    query: `${LICENSE_QUERY} (t-shirt OR tee OR sweatshirt OR hoodie OR joggers OR pyjamas OR kids OR boys) (site:next.co.uk OR site:hm.com OR site:zara.com OR site:zalando.co.uk OR site:asos.com)`,
    tag: "retailer",
  },
  {
    name: "Pinterest (via Bing)",
    query: `${LICENSE_QUERY} (shirt OR t-shirt OR sweatshirt OR hoodie OR joggers) site:pinterest`,
    tag: "pinterest",
  },
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
    if (!item?.image_url || !item?.product_url) continue;
    map.set(`${item.retailer}::${item.product_url}`, item);
  }
  return Array.from(map.values());
}

function normalizeRetailer(url) {
  const u = url.toLowerCase();
  if (u.includes("next.co.uk")) return "next";
  if (u.includes("hm.com") || u.includes("www2.hm.com")) return "hm";
  if (u.includes("zara.com")) return "zara";
  if (u.includes("pinterest.")) return "pinterest";
  if (u.includes("asos.com")) return "asos";
  if (u.includes("zalando.")) return "zalando";
  return "other";
}

function extractMeta(html, propertyOrName) {
  // property="og:image" content="..."
  const reProp = new RegExp(
    `<meta[^>]+property=["']${propertyOrName}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m1 = html.match(reProp);
  if (m1?.[1]) return m1[1];

  // name="twitter:image" content="..."
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
  // Fetch the page and extract og:image
  const { status, text: html } = await fetchText(url);

  // Pinterest sometimes blocks; still worth trying
  const ogImage =
    extractMeta(html, "og:image") ||
    extractMeta(html, "twitter:image") ||
    extractMeta(html, "image");

  const title = extractTitle(html);

  return {
    status,
    ogImage,
    title,
  };
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
  candidateUrls = Array.from(new Set(candidateUrls));

  // 2) Resolve each URL to a usable image (og:image)
  const maxToProcess = Math.min(candidateUrls.length, 250);

  for (let i = 0; i < maxToProcess; i++) {
    const url = candidateUrls[i];
    const retailer = normalizeRetailer(url);

    try {
      const { status, ogImage, title } = await resolveUrlToImage(url);

      processedLog.push({
        url,
        retailer,
        status,
        hasImage: !!ogImage,
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
