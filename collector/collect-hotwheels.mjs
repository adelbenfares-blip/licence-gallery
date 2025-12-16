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
        a.querySelector("picture
