import fs from "fs";

const OUT_PATH = "data/hot-wheels.json";
const DEBUG_DIR = "debug";
const QUERY = "hot wheels";
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  fs.mkdirSync("data", { recursive: true });
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

function logDebug(msg) {
  ensureDirs();
  fs.appendFileSync(`${DEBUG_DIR}/run.txt`, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
}

function dedupe(list) {
  const map = new Map();
  for (const item of list) {
    if (!item?.image_url || !item?.product_url) continue;
    map.set(`${item.retailer}::${item.product_url}`, item);
  }
  return Array.from(map.values());
}

async function dumpDebug(page, name) {
  ensureDirs();
  await page.screenshot({ path: `${DEBUG_DIR}/${name}.png`, fullPage: true });
  const html = await page.content();
  fs.writeFileSync(`${DEBUG_DIR}/${name}.html`, html, "utf-8");
}

async function autoScroll(page, times = 10) {
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, 1400);
    await sleep(500);
  }
}

async function tryAcceptCookies(page) {
  const selectors = [
    "#onetrust-accept-btn-handler",
    "button#onetrust-accept-btn-handler",
    "button:has-text('Accept all')",
    "button:has-text('Accept All')",
    "button:has-text('Accept')",
    "button:has-text('I agree')",
    "button:has-text('Agree')",
    "button:has-text('Allow all')",
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 1500 });
        await sleep(800);
        return true;
      }
    } catch {}
  }
  return false;
}

/* ---------------- H&M ---------------- */
async function collectHM(page) {
  const url = `https://www2.hm.com/en_gb/search-results.html?q=${encodeURIComponent(QUERY)}`;
  logDebug(`HM goto: ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  await dumpDebug(page, "hm_before_consent");
  await tryAcceptCookies(page);
  await sleep(800);
  await dumpDebug(page, "hm_after_consent");

  await autoScroll(page, 12);

  const items = await page.$$eval("a[href]", (anchors) => {
    const out = [];
    const seen = new Set();

    for (const a of anchors) {
      const href = a.href;
      if (!href || seen.has(href)) continue;
      if (!href.includes("/productpage.")) continue;

      const img =
        a.querySelector("img") ||
        a.querySelector("picture img") ||
        a.querySelector("[style*='background-image']");

      let src =
        img?.currentSrc ||
        img?.src ||
        img?.getAttribute?.("src") ||
        img?.getAttribute?.("data-src") ||
        img?.getAttribute?.("data-srcset");

      // Safe background-image parsing
      if (!src && img?.style?.backgroundImage) {
        const bg = img.style.backgroundImage;
        const m = bg.match(/url\((['"]?)(.*?)\1\)/);
        if (m && m[2]) src = m[2];
      }

      if (!src) continue;

      seen.add(href);
      out.push({ retailer: "hm", product_url: href, image_url: src });
    }

    return out;
  });

  results.push(...items);
  await dumpDebug(page, `hm_done_${items.length}`);
  logDebug(`HM items: ${items.length}`);
  return items.length;
}

/* ---------------- NEXT ---------------- */
async function collectNext(page) {
  const url = `https://www.next.co.uk/search?w=${encodeURIComponent(QUERY)}`;
  logDebug(`NEXT goto: ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  await dumpDebug(page, "next_before_consent");
  await tryAcceptCookies(page);
  await sleep(800);
  await dumpDebug(page, "next_after_consent");

  await autoScroll(page, 12);

  const items = await page.$$eval("a[href]", (anchors) => {
    const out = [];
    const seen = new Set();

    for (const a of anchors) {
      const href = a.href;
      if (!href || seen.has(href)) continue;
      if (!href.includes("next.co.uk")) continue;

      const img = a.querySelector("img") || a.querySelector("picture img");
      const src =
        img?.currentSrc ||
        img?.src ||
        img?.getAttribute?.("src") ||
        img?.getAttribute?.("data-src") ||
        img?.getAttribute?.("data-srcset");

      if (!src) continue;

      seen.add(href);
      out.push({ retailer: "next", product_url: href, image_url: src });
    }

    return out;
  });

  results.push(...items);
  await dumpDebug(page, `next_done_${items.length}`);
  logDebug(`NEXT items: ${items.length}`);
  return items.length;
}

/* ---------------- MAIN ---------------- */
async function main() {
  ensureDirs();
  fs.writeFileSync(`${DEBUG_DIR}/run.txt`, "", "utf-8");
  logDebug("Collector starting");

  const { chromium } = await import("playwright");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  // Guaranteed first debug capture (even before visiting retailer pages)
  await page.setContent("<html><body><h1>Collector started</h1></body></html>");
  await dumpDebug(page, "start");
  logDebug("Wrote start debug files");

  let hmCount = 0;
  let nextCount = 0;

  try {
    hmCount = await collectHM(page);
  } catch (e) {
    logDebug(`HM error: ${String(e)}`);
    await dumpDebug(page, "hm_error");
  }

  try {
    nextCount = await collectNext(page);
  } catch (e) {
    logDebug(`NEXT error: ${String(e)}`);
    await dumpDebug(page, "next_error");
  }

  await browser.close();

  const final = dedupe(results);
  fs.writeFileSync(OUT_PATH, JSON.stringify(final, null, 2), "utf-8");

  logDebug(`Finished. Total items: ${final.length} (hm=${hmCount}, next=${nextCount})`);
  console.log(`Finished. Total items: ${final.length} (hm=${hmCount}, next=${nextCount})`);
}

main().catch((e) => {
  logDebug(`Fatal error: ${String(e)}`);
  console.error(e);
  process.exit(1);
});
