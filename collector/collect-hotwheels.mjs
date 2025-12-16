import fs from "fs";

const LICENSE_SLUG = "hot-wheels";
const QUERY = "hot wheels";
const OUT_PATH = `data/${LICENSE_SLUG}.json`;

const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dedupe(list) {
  const m = new Map();
  for (const x of list) {
    if (!x?.image_url || !x?.product_url) continue;
    const key = `${x.retailer}::${x.product_url}`;
    if (!m.has(key)) m.set(key, x);
  }
  return Array.from(m.values());
}

function normalizeImage(url) {
  if (!url) return url;
  return url.split("?")[0] || url;
}

async function collectFromHM(page) {
  const url = `https://www2.hm.com/en_gb/search-results.html?q=${encodeURIComponent(QUERY)}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 1300);
    await sleep(450);
  }

  const items = await page.$$eval("a[href*='/productpage.']", (anchors) => {
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      const href = a.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);

      const img = a.querySelector("img") || a.querySelector("picture img");
      const src = img?.currentSrc || img?.src || img?.getAttribute("src");
      if (!src) continue;

      out.push({ retailer: "hm", product_url: href, image_url: src });
    }
    return out;
  });

  results.push(...items);
}

async function collectFromNext(page) {
  const url = `https://www.next.co.uk/search?w=${encodeURIComponent(QUERY)}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 1400);
    await sleep(450);
  }

  const items = await page.$$eval("a[href]", (anchors) => {
    const out = [];
    const seen = new Set();
    for (const a of anchors) {
      const href = a.href;
      if (!href || !href.includes("next.co.uk") || seen.has(href)) continue;

      const img = a.querySelector("img");
      const src = img?.currentSrc || img?.src || img?.getAttribute("src");
      if (!src) continue;

      seen.add(href);
      out.push({ retailer: "next", product_url: href, image_url: src });
    }
    return out;
  });

  results.push(...items);
}

async function main() {
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  try {
    await collectFromHM(page);
  } catch (e) {
    console.error("H&M collector failed:", e);
  }

  try {
    await collectFromNext(page);
  } catch (e) {
    console.error("Next collector failed:", e);
  }

  await browser.close();

  const final = dedupe(results).map((x) => ({
    ...x,
    image_url: normalizeImage(x.image_url),
  }));

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(final, null, 2), "utf-8");

  console.log(`✅ Wrote ${final.length} items to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
