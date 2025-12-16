# GitHub Hot Wheels Collector (No local installs)

This bundle adds a GitHub Actions workflow that runs a Playwright collector in the cloud and writes:
- data/hot-wheels.json

Your static index.html can then fetch and display the images from that JSON.

## How to use
1. Upload these files into the root of your repo.
2. Commit.
3. Go to Actions -> "Collect Hot Wheels" -> Run workflow (manual) to test.
4. It will also run daily on schedule (UTC).
