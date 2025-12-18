// collector/collect-hotwheels.mjs
// CDN-first collector (works on GitHub Actions without Playwright)
// - Uses Bing RSS web search
// - Also searches known retailer IMAGE CDNs to avoid bot blocks
// - Keeps only relevant results (Hot Wheels, apparel-ish)
// - Best-effort product_url; if unknown, uses the page link

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
const MAX_ITEMS = 600;
const RSS_PAGES_PER_QUERY = 10; // ~100 results/query

// IMPORTANT: keep previous JSON if new run returns 0 items
const KEEP_PREVIOUS_ON_EMPTY = true;

const RETAILERS = [
  // key, label, web domains (for product pages), image cdn domains
  { key: "zara", label: "Zara", web: ["zara.com"], cdn: ["static.zara.net"] },
  { key: "hm", label: "H&M", web: ["hm.com", "www2.hm.com"], cdn: ["image.hm.com", "lp2.hm.com"] },
  { key: "next", label: "Next", web: ["next.co.uk"], cdn: ["xcdn.next.co.uk"] },
  { key: "asos", label: "ASOS", web: ["asos.com"], cdn: ["images.asos-media.com"] },
  { key: "zalando", label: "Zalando", web: ["zalando.co.uk","zalando.com","zalando.de","zalando.fr","zalando.nl","zalando.it","zalando.es","zalando.be"], cdn: ["img01.ztat.net","img02.ztat.net","img.ztat.net"] },
  { key: "boxlunch", label: "BoxLunch", web: ["boxlunch.com"], cdn: ["cdn.shopify.com", "images.boxlunch.com"] },
  { key: "pacsun", label: "PacSun", web: ["pacsun.com"], cdn: ["images.pacsun.com"] },
  { key: "bucketsandspades", label: "Buckets & Spades", web: ["bucketsandspades.co.uk","bucketsandspades.com"], cdn: ["cdn.shopify.com"] },
  { key: "pinterest", label: "Pinterest", web: ["pinterest.com"], cdn: ["i.pinimg.com"] },
];

// Apparel-ish query terms to bias toward clothing
const APPAREL_TERMS = [
  "hoodie","sweatshirt","jumper","t-shirt","tee","joggers","pyjamas","pajamas",
  "kids","boys","girls","set","beanie","cap","hat","jacket","tracksuit"
];

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
function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function normUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString();
  } catch {
    return (u || "").trim();
  }
}
function stripParams(u) {
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
function isImageUrl(u) {
  return /\.(png|jpg|jpeg|webp)(\?|$)/i.test(u) || u.includes("hmgoepprod?");
}
function retailerForUrl(u) {
  const d = domainOf(u);
  for (const r of RETAILERS) {
    if (r.web.some(dom => d === dom || d.endsWith("." + dom))) return r.key;
    if (r.cdn.some(dom => d === dom || d.endsWith("." + dom))) return r.key;
  }
  return "other";
}

// Heuristics to avoid the “HOT” spam problem
function looksLikeHotWheels(u, title = "", desc = "") {
  const t = (title + " " + desc).toLowerCase();
  const url = (u || "").toLowerCase();

  // must contain both words somewhere (url or snippet)
  const hasLicense =
    t.includes("hot wheels") || t.includes("hotwheels") ||
    (url.includes("hot") && url.includes("wheel"));

  if (!hasLicense) return false;

  // strongly prefer apparel content
  const apparelHit = APPAREL_TERMS.some(k => t.includes(k) || url.includes(k.replace("-", "")));
  return apparelHit || url.includes("product") || url.includes("style/") || url.includes("prd/");
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
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

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.split("<item>").slice(1);
  for (const b of blocks) {
    const title = (b.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    const link = (b.match(/<link>([^<]+)<\/link>/i)?.[1] || "").trim();
    const desc = (b.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "").trim();
    if (link) items.push({ title, link, desc });
  }
  return items;
}

async function bingRss(query, start = 1) {
  const q = encodeURIComponent(query);
  const url = `https://www.bing.com/search?q=${q}&format=rss&first=${start}`;
  const { ok, status, text, error } = await fetchText(url, 20000);
  if (!ok) {
    log(`BING RSS FAIL status=${status} start=${start} err=${error || "unknown"}`);
    return [];
  }
  return parseRssItems(text);
}

function extractOgImage(html) {
  const og = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (og?.[1]) return og[1].trim();
  const tw = html.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (tw?.[1]) return tw[1].trim();
  return "";
}

function extractFirstImage(html) {
  // best-effort: grab first “real” image-looking URL
  const matches = [...html.matchAll(/https?:\/\/[^"' )]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?/gi)].map(m => m[0]);
  for (const u of matches) {
    if (/sprite|icon|logo|favicon/i.test(u)) continue;
    return u;
  }
  // HM alternate image endpoint
  const hmAlt = html.match(/https?:\/\/lp2\.hm\.com\/hmgoepprod\?[^"']+/i)?.[0];
  return hmAlt || "";
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const img = normUrl(it.image_url || "");
    const prod = normUrl(it.product_url || "");
    if (!img || !prod) continue;
    const key = stripParams(img); // strong dedupe on image
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...it, image_url: img, product_url: prod });
  }
  return out;
}

async function main() {
  ensureDir(DEBUG_DIR);
  fs.writeFileSync(RUN_LOG, "", "utf8");

  const processed = {
    started_at: new Date().toISOString(),
    kept: 0,
    considered: 0,
    direct_images: 0,
    fetched_pages: 0,
    blocked_or_failed: 0,
    filtered_out: 0,
    queries: []
  };

  log(`Collector started: ${LICENSE}`);

  const results = [];

  // Build search plan:
  // 1) Retailer web domains (product pages)
  // 2) Retailer CDN domains (direct images, avoids bot blocks)
  const plan = [];
  for (const r of RETAILERS) {
    for (const term of APPAREL_TERMS) {
      for (const dom of r.web) {
        plan.push({ retailer: r.key, query: `"${LICENSE}" ${term} site:${dom}` });
      }
      for (const dom of r.cdn) {
        // CDN searches often work better without apparel term, but we keep it to reduce noise
        plan.push({ retailer: r.key, query: `"${LICENSE}" ${term} site:${dom}` });
      }
    }
  }

  for (const q of plan) {
    if (results.length >= MAX_ITEMS) break;

    log(`--- QUERY [${q.retailer}] ${q.query}`);
    const qLog = { retailer: q.retailer, query: q.query, rss_items: 0, kept: 0 };
    processed.queries.push(qLog);

    let items = [];
    for (let p = 0; p < RSS_PAGES_PER_QUERY; p++) {
      const start = 1 + p * 10;
      const pageItems = await bingRss(q.query, start);
      items = items.concat(pageItems);
      await new Promise(r => setTimeout(r, 250));
    }

    qLog.rss_items = items.length;

    for (const it of items) {
      if (results.length >= MAX_ITEMS) break;

      const link = normUrl(it.link);
      if (!link) continue;

      processed.considered += 1;

      if (!looksLikeHotWheels(link, it.title, it.desc)) {
        processed.filtered_out += 1;
        continue;
      }

      const retailer = retailerForUrl(link);

      // If the result link itself is a direct image (CDN), keep immediately
      if (isImageUrl(link)) {
        processed.direct_images += 1;
        results.push({
          retailer,
          product_url: link, // best effort (image link)
          image_url: link
        });
        qLog.kept += 1;
        processed.kept += 1;
        continue;
      }

      // Otherwise fetch the page and try to pull OG image / first image
      processed.fetched_pages += 1;
      const { ok, status, text } = await fetchText(link, 20000);
      if (!ok || status >= 400) {
        processed.blocked_or_failed += 1;
        continue;
      }

      // Extra relevance gate: page must contain Hot Wheels text somewhere
      const lower = text.toLowerCase();
      if (!(lower.includes("hot wheels") || lower.includes("hotwheels"))) {
        processed.filtered_out += 1;
        continue;
      }

      const og = extractOgImage(text);
      const img = og || extractFirstImage(text);

      if (!img) {
        processed.filtered_out += 1;
        continue;
      }

      results.push({
        retailer,
        product_url: link,
        image_url: img
      });

      qLog.kept += 1;
      processed.kept += 1;

      await new Promise(r => setTimeout(r, 200));
    }
  }

  const finalItems = dedupe(results).slice(0, MAX_ITEMS);

  // If empty and KEEP_PREVIOUS_ON_EMPTY, do NOT overwrite existing JSON
  if (finalItems.length === 0 && KEEP_PREVIOUS_ON_EMPTY) {
    log(`No items found. Keeping previous hot-wheels.json (not overwriting).`);
    processed.ended_at = new Date().toISOString();
    safeJsonWrite(PROCESSED_JSON, processed);
    process.exitCode = 0;
    return;
  }

  log(`Done. kept=${finalItems.length}`);
  safeJsonWrite(OUT_JSON, finalItems);
  processed.ended_at = new Date().toISOString();
  safeJsonWrite(PROCESSED_JSON, processed);
  log(`Collector finished.`);
}

main().catch((e) => {
  ensureDir(DEBUG_DIR);
  fs.appendFileSync(RUN_LOG, `\nFATAL: ${String(e?.stack || e)}\n`);
  process.exitCode = 0; // don't fail workflow
});

