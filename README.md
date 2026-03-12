# GMS Config - APKMirror Crawler Service

Automatically fetches the latest versions and direct download links for the Google “GMS trio” from APKMirror, and generates `variants.json` for the GMS installer assistant app.

## How it works

```
┌─────────────────────────────────────────────────┐
│          GitHub Actions (scheduled daily)        │
│                                                   │
│  1. Launch Playwright browser                     │
│  2. Visit APKMirror and get the latest versions   │
│     of the GMS trio                               │
│  3. Iterate all variants for each version         │
│  4. Simulate clicks to extract direct URLs        │
│  5. Generate variants.json                        │
│  6. Auto commit & push                            │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│        variants.json (hosted on GitHub)           │
│                                                   │
│    The GMS app fetches this file on startup       │
│    → Get APK direct links that match the device   │
│    → One-tap download, no manual version hunting  │
└─────────────────────────────────────────────────┘
```

## Quick start

### 1. Run locally (first-time testing)

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/gms-config.git
cd gms-config

# Install dependencies
npm install

# Install Playwright browsers (~200MB)
npx playwright install chromium --with-deps

# Test the crawler with a single URL first
node scripts/test-single.js "https://www.apkmirror.com/apk/google-inc/google-services-framework/google-services-framework-14-8692178-release/"

# If it passes, run the full crawler
npm run crawl

# Validate the generated output
npm run validate
```

### 2. Deploy to GitHub Actions (automation)

```bash
# Push to GitHub
git add .
git commit -m "init: crawler service"
git push origin main

# Go to GitHub repo → Settings → Actions → General
# Make sure "Allow GitHub Actions to create and approve pull requests" is enabled
# Make sure Workflow permissions is set to "Read and write permissions"

# Manually trigger the first run:
# GitHub repo → Actions → Update GMS Variants → Run workflow
```

After that, the crawler will run every day at 10:00 (China Standard Time).

### 3. Integrate with the Flutter app

Update `_configUrl` in the app’s `version_matcher.dart`:

```dart
static const _configUrl =
    'https://raw.githubusercontent.com/YOUR_USERNAME/gms-config/main/variants.json';
```

## Project structure

```
gms-config/
├── .github/workflows/
│   └── update-variants.yml    # GitHub Actions automation config
├── config/
│   └── packages.json          # Target packages (edit to add/remove)
├── scripts/
│   ├── crawl.js               # Core crawler script
│   ├── validate.js            # Output validation script
│   └── test-single.js         # Single-URL test tool
├── variants.json              # [AUTO-GENERATED] config consumed by the app
├── package.json
└── README.md
```

## `variants.json` format

```jsonc
{
  "config_version": 2,
  "updated_at": "2025-03-10",
  "packages": {
    "gsf": {
      "name": "Google Services Framework",
      "package_name": "com.google.android.gsf",
      "version": "14-8692178",
      "install_order": 1,
      "variants": [
        {
          "variant_label": "14-8692178 / universal",
          "min_api": 21,           // minimum supported API level
          "max_api": null,         // null means no upper bound
          "abis": ["arm64-v8a", "armeabi-v7a"],
          "dpi": "nodpi",
          "file_size_mb": 3,
          "download_page_url": "https://www.apkmirror.com/apk/...",   // fallback web page
          "direct_url": "https://www.apkmirror.com/wp-content/themes/APKMirror/download.php?id=xxx&key=xxx",  // direct link
          "sha256": null
        }
      ]
    },
    "gps": { ... },
    "store": { ... }
  }
}
```

Matching logic on the app side:
1. Read the device `apiLevel` and `cpuArch`
2. For each package, filter variants where `min_api <= device API <= max_api` and `abis` contains the device architecture
3. Prefer `direct_url` for direct download
4. If `direct_url` is null or expired, fall back to opening `download_page_url`

## FAQ

### What if Cloudflare blocks the crawler?

The crawler includes multiple mitigations out of the box:
- Uses a real browser (Playwright Chromium), not plain HTTP requests
- Spoofs User-Agent and browser fingerprints
- Removes webdriver indicators
- Adds a 3–5 second delay between requests

If you still get blocked, try:
1. Increase `DELAY_BETWEEN_PAGES` and `DELAY_BETWEEN_VARIANTS`
2. Switch to `headless: false` in `crawl.js` for local debugging (you can solve CAPTCHAs manually)
3. Use a proxy (set `PROXY_URL` in GitHub Actions environment variables)

### How long do direct links stay valid?

APKMirror direct links are usually valid for 24–48 hours. That’s why a daily update is recommended. If a direct link expires, the app will automatically fall back to the web flow, so usage is not impacted.

### How do I add new device-matching rules?

Edit the `TARGET_COMBINATIONS` array at the top of `crawl.js`:

```javascript
const TARGET_COMBINATIONS = [
  // Add a rule
  { arch: "x86_64", minAndroid: "13.0", label: "x86_64 / Android 13+ (emulator)" },
];
```

### Can I update only one package?

Not currently. As a workaround, edit `config/packages.json` and temporarily comment out packages you don’t want to update.

### GitHub Actions timeout

The default timeout is 30 minutes. If there are many variants, crawling can take longer. You can adjust it in the workflow:

```yaml
timeout-minutes: 45
```

## Maintenance tips

- **Check Actions logs monthly** to ensure the crawler is running correctly
- If APKMirror layout changes and selectors break, debug with `test-single.js` and update selectors in `crawl.js`
- Watch for major GMS releases from Google (especially versions that require a newer API level)
- Keep `approx_size_mb` in `config/packages.json` roughly accurate
