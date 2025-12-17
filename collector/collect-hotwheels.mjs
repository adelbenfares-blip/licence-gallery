// collector/collect-hotwheels.mjs
// Fail-soft collector with HARD relevance filtering:
// - Only keeps likely product pages per retailer (patterns)
// - Requires page HTML to include "hot wheels" or "hotwheels"
// - Requires an apparel keyword to reduce toy/news/logo spam
// - Pinterest pins must contain hot wheels in page HTML

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const OUT_JSON = path.join(ROOT, "data", "hot-wheels.json");
const DEBUG_DIR = path.join(ROOT, "debug");
const RUN_LOG = path.join(DEBUG_DIR, "run.txt");
const PROCESSED_JSON = path.join(DEBUG_DIR, "processed.json");

const LICENSE = "Hot Wheels";

// target more items if you want
const MAX_ITEMS = 800;

// Bing RSS returns ~10 items/page; keep sane
const RSS_PAGES_PER_QUERY = 8; // ~80 results/query

// strong apparel terms help Bing return actual clothing pages
const QUERY_TEMPLATES = [
  `"${LICENSE}" kids hoodie`,
  `"${LICENSE}" boys hoodie`,
  `"${LICENSE}" kids sweatshirt`,
  `"${LICENSE}" boys sweatshirt`,
  `"${LICENSE}" kids t-shirt`,
  `"${LICENSE}" boys t-shirt`,
  `"${LICENSE}" pyjamas`,
  `"${LICENSE}" pajamas`,
  `"${LICENSE}" clothing`,
  `"${LICENSE}" apparel`,
  `"${LICENSE}" beanie`,
  `"${LICENSE}" cap`,
  `"${LICENSE}" jacket`,
  `"${LICENSE}" set`,
];

const APPAREL_KEYWORDS = [
  "hoodie","sweatshirt","sweater","jumper","t-shirt","tshirt","tee",
  "jogger","joggers","pants","trousers","shorts","leggings",
  "pyjama","pyjamas","pajama","pajamas","onesie","romper",
  "jacket","coat","beanie","hat","cap","socks","top","set",
  "kids","boys","girls","infant","toddler"
];

// Retailers + URL patterns that look like product pages.
// NOTE: add patterns over time as you discover real URL formats.
const RETAILERS = [
  {
    key: "zara",
    domains: ["zara.com"],
    productUrlPatterns: [
      /\/\d+\.html/i,              // common zara product ids
      /\/product\//i
    ]
  },
  {
    key: "hm",
    domains: ["hm.com", "www2.hm.com"],
    productUrlPatterns: [
      /\/productpage\.\d+/i
    ]
  },
  {
    key: "next",
    domains: ["next.co.uk"],
    productUrlPatterns: [
      /\/style\/[a-z0-9]+\/[a-z0-9]+/i
    ]
  },
  {
    key: "asos",
    domains: ["asos.com"],
    productUrlPatterns: [
      /\/prd\/\d+/i
    ]
  },
  {
    key: "zalando",
    domains: ["zalando.co.uk","zalando.com","zalando.de","zalando.fr","zalando.nl","zalando.it","zalando.es","zalando.be"],
    productUrlPatterns: [
      /\/p\//i,                    // many zalando product urls
      /\/t\//i
    ]
  },
  {
    key: "boxlunch",
    domains: ["boxlunch.com"],
    productUrlPatterns: [
      /\/product\//i
    ]
  },
  {
    key: "pacsun",
    domains: ["pacsun.com"],
    productUrlPatterns: [
      /\/product\//i
    ]
  },
  {
    key: "bucketsandspades",
    domains: ["bucketsandspades.co.uk","bucketsandspades.com"],
    productUrlPatterns: [
      /\/products\//i
    ]
  },
  {
    key: "pinterest",
    domains: ["pinterest.com"],
    productUrlPatterns: [
      /\/pin\//i
    ]
  },
];

// ---------- utils ----------
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function log(line) {
  ensureDir(DEBUG_DIR);
  fs.appendFileSync(RUN_LOG, line + "\n");
  console.log(line);
}
function safeJsonWrite(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function normUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    // normalize common image params for dedupe
    if (url.searchParams.has("imwidth")) url.searchParams.delete("imwidth");
    if (url.searchParams.has("wid")) url.searchParams.delete("wid");
    if (url.searchParams.has("hei")) url.searchParams.delete("hei");
    return url.toString();
  } catch {
    return (u || "").trim();
  }
}
function stripImageParams(u) {
  try {
    const url = new URL(u);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return (u || "").trim();
  }
}
function domainOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ""; }
}
function matchesDomain(url, domains) {
  const d = domainOf(url);
  return domains.some(dom => d === dom || d.endsWith("." + dom));
}
function retailerForUrl(url) {
  for (const r of RETAILERS) {
    if (matchesDomain(url, r.domains)) return r;
  }
  return null;
}

function isLikelyProductUrl(url, retailer) {
  if (!retailer) return false;
  return retailer.productUrlPatterns.some(rx => rx.test(url));
}

function textHasLicense(htmlOrText) {
  const t = (htmlOrText || "").toLowerCase();
  return t.includes("hot wheels") || t.includes("hotwheels");
}

function textHasApparel(htmlOrText) {
  const t = (htmlOrText || "").toLowerCase();
  return APPAREL_KEYWORDS.some(k => t.includes(k));
}

async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function parseRssLinks(xml) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1);
  for (const block of itemBlocks) {
    const linkMatch = block.match(/<link>([^<]+)<\/link>/i);
    if (linkMatch?.[1]) items.push(linkMatch[1].trim());
  }
  return items;
}

async function bingRssSearch(query, start = 1) {
  const q = encodeURIComponent(query);
  const url = `https://www.bing.com/search?q=${q}&format=rss&first=${start}`;
  const { ok, status, text, error } = await fetchText(url, { timeoutMs: 20000 });
  if (!ok) {
    log(`BING RSS FAIL status=${status} start=${start} err=${error || "unknown"}`);
    return [];
  }
  return parseRssLinks(text);
}

function extractOgImage(html) {
  const og = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (og?.[1]) return og[1].trim();
  const tw = html.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (tw?.[1]) return tw[1].trim();
  return "";
}

function extractFirstLikelyImage(html, retailerKey) {
  const candidates = [];

  // retailer-specific first
  if (retailerKey === "next") {
    for (const m of html.matchAll(/https?:\/\/xcdn\.next\.co\.uk\/[^"' )]+?\.(?:jpg|jpeg|png)/gi)) candidates.push(m[0]);
  }
  if (retailerKey === "hm") {
    for (const m of html.matchAll(/https?:\/\/image\.hm\.com\/[^"' )]+?\.(?:jpg|jpeg|png)(?:\?[^"']*)?/gi)) candidates.push(m[0]);
    for (const m of html.matchAll(/https?:\/\/lp2\.hm\.com\/hmgoepprod\?[^"']+/gi)) candidates.push(m[0]);
  }
  if (retailerKey === "pinterest") {
    for (const m of html.matchAll(/https?:\/\/i\.pinimg\.com\/[^"' )]+?\.(?:jpg|jpeg|png)/gi)) candidates.push(m[0]);
  }

  // generic fallback
  for (const m of html.matchAll(/https?:\/\/[^"' )]+?\.(?:jpg|jpeg|png)(?:\?[^"']*)?/gi)) {
    const u = m[0];
    if (/sprite|icon|logo|favicon/i.test(u)) continue;
    candidates.push(u);
  }
  return candidates[0] || "";
}

async function getPageImageIfRelevant(productUrl, retailerKey) {
  const { ok, status, text, error } = await fetchText(productUrl, { timeoutMs: 20000 });
  if (!ok) return { image: "", status, error, relevant: false };

  // HARD relevance: must mention Hot Wheels
  const hasLicense = textHasLicense(text);

  // apparel keyword requirement removes “hot” icon spam and toy pages
  const hasApparel = textHasApparel(text);

  // Pinterest is extremely noisy: require BOTH
  if (retailerKey === "pinterest") {
    if (!hasLicense) return { image: "", status, relevant: false };
    // optional: keep pins even if apparel keyword missing IF license exists
    // but usually better to require apparel too:
    if (!hasApparel) return { image: "", status, relevant: false };
  } else {
    if (!hasLicense) return { image: "", status, relevant: false };
    if (!hasApparel) return { image: "", status, relevant: false };
  }

  const og = extractOgImage(text);
  if (og) return { image: og, status, relevant: true };

  const fb = extractFirstLikelyImage(text, retailerKey);
  return { image: fb || "", status, relevant: true };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const product = normUrl(it.product_url || "");
    const img = normUrl(it.image_url || "");
    if (!product || !img) continue;

    // dedupe by image (strong) + product (backup)
    const key = `${stripImageParams(img)}::${product}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...it, product_url: product, image_url: img });
  }
  return out;
}

// ---------- main ----------
async function main() {
  ensureDir(DEBUG_DIR);
  fs.writeFileSync(RUN_LOG, "", "utf8");

  const processed = {
    started_at: new Date().toISOString(),
    notes: [],
    queries: [],
    totals: {
      rss_links: 0,
      considered_urls: 0,
      skipped_not_product_url: 0,
      skipped_not_relevant: 0,
      blocked_or_failed: 0,
      kept: 0
    }
  };

  log(`Collector started`);
  log(`License: ${LICENSE}`);
  log(`Max items: ${MAX_ITEMS}`);

  const found = [];

  // Build queries per retailer domain
  const searchPlan = [];
  for (const r of RETAILERS) {
    const dom = r.domains[0];
    for (const t of QUERY_TEMPLATES) {
      searchPlan.push({ retailer: r.key, query: `${t} site:${dom}` });
    }
  }

  for (const q of searchPlan) {
    if (found.length >= MAX_ITEMS) break;

    log(`--- QUERY [${q.retailer}] ${q.query}`);
    const qLog = { retailer: q.retailer, query: q.query, rss_pages: 0, rss_links: 0, kept: 0 };
    processed.queries.push(qLog);

    let links = [];
    for (let p = 0; p < RSS_PAGES_PER_QUERY; p++) {
      const start = 1 + p * 10;
      const pageLinks = await bingRssSearch(q.query, start);
      qLog.rss_pages += 1;
      qLog.rss_links += pageLinks.length;
      processed.totals.rss_links += pageLinks.length;
      links = links.concat(pageLinks);

      await new Promise(r => setTimeout(r, 300));
    }

    // normalize & de-dupe links
    links = Array.from(new Set(links.map(normUrl)))
      .filter(u => u.startsWith("http"));

    for (const url of links) {
      if (found.length >= MAX_ITEMS) break;

      processed.totals.considered_urls += 1;

      const retailer = retailerForUrl(url);
      if (!retailer) continue;

      // enforce product-url patterns
      if (!isLikelyProductUrl(url, retailer)) {
        processed.totals.skipped_not_product_url += 1;
        continue;
      }

      const { image, status, relevant } = await getPageImageIfRelevant(url, retailer.key);
      if (!relevant || !image) {
        processed.totals.skipped_not_relevant += 1;
        continue;
      }

      // normalize / keep
      found.push({
        retailer: retailer.key,
        product_url: url,
        image_url: image
      });

      qLog.kept += 1;
      processed.totals.kept += 1;

      if (processed.totals.kept % 25 === 0) {
        log(`Kept ${processed.totals.kept} items so far...`);
      }

      await new Promise(r => setTimeout(r, 250));
    }
  }

  const finalItems = dedupe(found).slice(0, MAX_ITEMS);

  log(`Done. kept=${finalItems.length}`);
  safeJsonWrite(OUT_JSON, finalItems);
  safeJsonWrite(PROCESSED_JSON, processed);

  log(`Collector finished successfully (fail-soft).`);
}

main().catch((e) => {
  try {
    ensureDir(DEBUG_DIR);
    fs.appendFileSync(RUN_LOG, `\nFATAL (caught): ${String(e?.stack || e)}\n`);
    ensureDir(path.dirname(OUT_JSON));
    fs.writeFileSync(OUT_JSON, "[]", "utf8");
  } catch {}
  process.exitCode = 0; // never fail workflow
});
