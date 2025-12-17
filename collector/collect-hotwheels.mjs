// collector/collect-hotwheels.mjs
// Fail-soft collector: uses Bing RSS -> visits pages -> extracts og:image (best effort)
// Writes data/hot-wheels.json + debug/* and NEVER crashes the workflow.

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

// Increase if you want more total results in the JSON
const MAX_ITEMS = 800;

// Bing RSS returns 10 items/page typically; we paginate RSS by first=
// Keep this sane to avoid long runs / throttling
const RSS_PAGES_PER_QUERY = 6; // ~60 results/query

// More query variety -> more results
const QUERY_TEMPLATES = [
  `"${LICENSE}" kids hoodie`,
  `"${LICENSE}" sweatshirt`,
  `"${LICENSE}" t-shirt`,
  `"${LICENSE}" tee`,
  `"${LICENSE}" pyjamas`,
  `"${LICENSE}" pajamas`,
  `"${LICENSE}" set`,
  `"${LICENSE}" hat`,
  `"${LICENSE}" beanie`,
];

const RETAILERS = [
  { key: "zara", label: "Zara", domains: ["zara.com"] },
  { key: "hm", label: "H&M", domains: ["hm.com", "www2.hm.com"] },
  { key: "next", label: "Next", domains: ["next.co.uk", "xcdn.next.co.uk"] },
  { key: "asos", label: "ASOS", domains: ["asos.com"] },
  { key: "zalando", label: "Zalando", domains: ["zalando.co.uk", "zalando.com", "zalando.de", "zalando.fr", "zalando.nl", "zalando.it", "zalando.es", "zalando.be"] },
  { key: "boxlunch", label: "BoxLunch", domains: ["boxlunch.com"] },
  { key: "pacsun", label: "PacSun", domains: ["pacsun.com"] },
  { key: "bucketsandspades", label: "Buckets & Spades", domains: ["bucketsandspades.co.uk", "bucketsandspades.com"] },
  { key: "pinterest", label: "Pinterest", domains: ["pinterest.com", "pinimg.com"] },
];

// ---------- utils ----------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
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
    // normalize tracking-ish query for image dedupe
    if (url.searchParams.has("imwidth")) url.searchParams.delete("imwidth");
    if (url.searchParams.has("wid")) url.searchParams.delete("wid");
    if (url.searchParams.has("hei")) url.searchParams.delete("hei");
    return url.toString();
  } catch {
    return (u || "").trim();
  }
}
function stripImageParams(u) {
  // for stronger dedupe across CDNs
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
function matchesRetailer(url, retailer) {
  const d = domainOf(url);
  return retailer.domains.some(dom => d === dom || d.endsWith("." + dom));
}
function guessRetailerKeyFromUrl(url) {
  for (const r of RETAILERS) {
    if (matchesRetailer(url, r)) return r.key;
  }
  return "other";
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
  // Minimal RSS parsing: pull <link>...</link> inside <item>
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1);
  for (const block of itemBlocks) {
    const linkMatch = block.match(/<link>([^<]+)<\/link>/i);
    if (linkMatch?.[1]) items.push(linkMatch[1].trim());
  }
  return items;
}

async function bingRssSearch(query, start = 1) {
  // Bing RSS: q=...&first=...
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
  // og:image
  const og = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (og?.[1]) return og[1].trim();

  // twitter:image
  const tw = html.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (tw?.[1]) return tw[1].trim();

  return "";
}

function extractFirstLikelyProductImage(html) {
  // fallback: look for common CDN patterns
  const candidates = [];

  // next.co.uk CDN
  for (const m of html.matchAll(/https?:\/\/xcdn\.next\.co\.uk\/[^"' )]+?\.(?:jpg|jpeg|png)/gi)) {
    candidates.push(m[0]);
  }

  // hm image CDN
  for (const m of html.matchAll(/https?:\/\/image\.hm\.com\/[^"' )]+?\.(?:jpg|jpeg|png)(?:\?[^"']*)?/gi)) {
    candidates.push(m[0]);
  }
  for (const m of html.matchAll(/https?:\/\/lp2\.hm\.com\/hmgoepprod\?[^"']+/gi)) {
    candidates.push(m[0]);
  }

  // pinimg
  for (const m of html.matchAll(/https?:\/\/i\.pinimg\.com\/[^"' )]+?\.(?:jpg|jpeg|png)/gi)) {
    candidates.push(m[0]);
  }

  // generic image-ish
  for (const m of html.matchAll(/https?:\/\/[^"' )]+?\.(?:jpg|jpeg|png)(?:\?[^"']*)?/gi)) {
    const u = m[0];
    if (/sprite|icon|logo|favicon/i.test(u)) continue;
    candidates.push(u);
  }

  return candidates[0] || "";
}

async function getPageImage(url) {
  const { ok, status, text, error } = await fetchText(url, { timeoutMs: 20000 });
  if (!ok) return { image: "", status, error };

  const og = extractOgImage(text);
  if (og) return { image: og, status };

  const fb = extractFirstLikelyProductImage(text);
  return { image: fb || "", status };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];

  for (const it of items) {
    const product = normUrl(it.product_url || "");
    const img = normUrl(it.image_url || "");

    if (!product || !img) continue;

    const key = `${product}::${stripImageParams(img)}`;
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

  log(`Collector started`);
  log(`License: ${LICENSE}`);
  log(`Max items: ${MAX_ITEMS}`);

  const found = [];
  const processed = {
    started_at: new Date().toISOString(),
    queries: [],
    notes: [],
    totals: { links: 0, pages_ok: 0, pages_blocked: 0, items: 0 }
  };

  // Build queries per retailer domain + a general (no-domain) query
  const retailerQueries = [];
  for (const r of RETAILERS) {
    // Pinterest: allow broad to increase variety
    const dom = r.domains[0];
    for (const t of QUERY_TEMPLATES) {
      retailerQueries.push({ retailer: r.key, query: `${t} site:${dom}` });
    }
  }
  // General queries (other-domain fallback)
  for (const t of QUERY_TEMPLATES) {
    retailerQueries.push({ retailer: "other", query: t });
  }

  // Crawl RSS for each query (paged)
  for (const q of retailerQueries) {
    if (found.length >= MAX_ITEMS) break;

    log(`--- QUERY [${q.retailer}] ${q.query}`);
    const qLog = { retailer: q.retailer, query: q.query, rss_pages: 0, links: 0, extracted: 0 };
    processed.queries.push(qLog);

    let allLinks = [];
    for (let p = 0; p < RSS_PAGES_PER_QUERY; p++) {
      const start = 1 + p * 10;
      const links = await bingRssSearch(q.query, start);
      qLog.rss_pages += 1;
      qLog.links += links.length;
      processed.totals.links += links.length;
      allLinks = allLinks.concat(links);

      // tiny pause
      await new Promise(r => setTimeout(r, 350));
    }

    // normalize & lightly filter obvious junk
    allLinks = Array.from(new Set(allLinks.map(normUrl)))
      .filter(u => u.startsWith("http"))
      .filter(u => !u.includes("merriam-webster.com") && !u.includes("dictionary.") && !u.includes("wikipedia.org"));

    for (const link of allLinks) {
      if (found.length >= MAX_ITEMS) break;

      const retailerKey = q.retailer === "other" ? guessRetailerKeyFromUrl(link) : q.retailer;

      // For "other" queries, only keep if it looks like one of our retailers (or pinterest).
      if (q.retailer === "other") {
        const ok = RETAILERS.some(r => matchesRetailer(link, r));
        if (!ok) continue;
      }

      const { image, status, error } = await getPageImage(link);

      if (!image) {
        if (status === 403 || status === 429) processed.totals.pages_blocked += 1;
        continue;
      }

      processed.totals.pages_ok += 1;

      found.push({
        retailer: retailerKey,
        product_url: link,
        image_url: image
      });

      qLog.extracted += 1;

      if (qLog.extracted % 10 === 0) {
        log(`Extracted ${qLog.extracted} from this query... total=${found.length}`);
      }

      // tiny pause to reduce blocks
      await new Promise(r => setTimeout(r, 250));
    }
  }

  const finalItems = dedupe(found).slice(0, MAX_ITEMS);
  processed.totals.items = finalItems.length;

  log(`Done. items=${finalItems.length}`);
  safeJsonWrite(OUT_JSON, finalItems);
  safeJsonWrite(PROCESSED_JSON, processed);

  // Always succeed
  log(`Collector finished successfully (fail-soft).`);
}

main().catch((e) => {
  // Even if something unexpected happens, write empty-but-valid output
  try {
    ensureDir(DEBUG_DIR);
    fs.appendFileSync(RUN_LOG, `\nFATAL (caught): ${String(e?.stack || e)}\n`);
    ensureDir(path.dirname(OUT_JSON));
    fs.writeFileSync(OUT_JSON, "[]", "utf8");
  } catch {}
  // Never fail the workflow
  process.exitCode = 0;
});
