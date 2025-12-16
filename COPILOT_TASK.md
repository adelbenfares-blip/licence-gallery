Goal: Set up an auto-updating data feed for a static HTML licence gallery for the Hot Wheels licence.

Please add these files exactly (paths are important):
- package.json (module type, dependency playwright, script collect:hotwheels)
- collector/collect-hotwheels.mjs (Playwright collector that writes data/hot-wheels.json)
- .github/workflows/collect-hotwheels.yml (runs daily + workflow_dispatch, commits updated JSON)
- data/hot-wheels.json initialized as []

The collector should scrape from:
- https://www2.hm.com/en_gb/search-results.html?q=hot%20wheels
- https://www.next.co.uk/search?w=hot%20wheels

Output JSON format:
[
  { "retailer": "hm|next", "image_url": "...", "product_url": "..." }
]

After adding files, ensure GitHub Actions can push commits (permissions: contents write).
Do NOT modify index.html.
