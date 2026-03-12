/**
 * APKMirror crawler — two-phase architecture
 *
 * Phase 1  Discovery  (no browser)
 *   Read each package's public RSS feed.
 *   Compare the latest entry against state.json.
 *   → No new version: skip the package entirely, reuse existing variants.json data.
 *   → New version found: enqueue for Phase 2.
 *
 * Phase 2  Detail extraction  (browser, only when Phase 1 finds something new)
 *   For each newly discovered version, fetch the variant table and download links.
 *   Parsed variant results are cached to cache/<hash>.json so re-runs after a
 *   selector fix can replay local data instead of hitting the live site.
 *   On Cloudflare challenge or parse error: log to review_queue, skip, retry tomorrow.
 *
 * Rate-limiting
 *   DELAY_BETWEEN_PAGES   – minimum pause between any two page loads
 *   DELAY_BETWEEN_VARIANTS – additional pause before fetching a download link
 *   Exponential back-off on retries: 5 s → 10 s → 20 s
 */

"use strict";

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const discovery = require("./lib/discovery");
const stateStore = require("./lib/state");
const cache = require("./lib/cache");

// ============================================================
//  Configuration
// ============================================================

const BASE_URL = "https://www.apkmirror.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const DELAY_BETWEEN_PAGES = 3000;     // ms — respects Crawl-delay: 3
const DELAY_BETWEEN_VARIANTS = 5000;  // ms — extra pause before download-link fetch

// deviceApi: the API level of the target device — used for "minSdk ≤ deviceApi" matching.
// minApi / maxApi: the values written into variants.json for the installer to filter.
// Android version → API level mapping:
//   14+  → 34 / null   (no upper bound)
//   13   → 33 / 33
//   12   → 31 / 32     (includes 12L, API 32)
//   11   → 30 / 30
//   armv7/11+ → 30 / null  (covers all armv7 devices regardless of Android ver)
const TARGET_COMBINATIONS = [
  { arch: "arm64-v8a",   deviceApi: 34, minApi: 34, maxApi: null, label: "arm64-v8a / Android 14+" },
  { arch: "arm64-v8a",   deviceApi: 33, minApi: 33, maxApi: 33,   label: "arm64-v8a / Android 13"  },
  { arch: "arm64-v8a",   deviceApi: 31, minApi: 31, maxApi: 32,   label: "arm64-v8a / Android 12"  },
  { arch: "arm64-v8a",   deviceApi: 30, minApi: 30, maxApi: 30,   label: "arm64-v8a / Android 11"  },
  { arch: "armeabi-v7a", deviceApi: 30, minApi: 30, maxApi: null, label: "armv7 / Android 11+"     },
];

// ============================================================
//  Utilities
// ============================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function logError(msg) {
  console.error(`[${new Date().toISOString().slice(11, 19)}] ❌ ${msg}`);
}

/**
 * Parse "Android 14.0+" / "Android 12L+" / "5.0+" / "minSdk 33" style strings
 * into a float version number. Android 12L maps to 12.1.
 * Returns 0 when nothing is recognised (= no Android version restriction).
 */
function parseAndroidVersion(text) {
  // Android 12L / 12.1 (API 32)
  const androidLMatch = text.match(/android\s+(\d+)L/i);
  if (androidLMatch) return parseFloat(androidLMatch[1]) + 0.1;

  const androidMatch = text.match(/android\s+(\d+(?:\.\d+)?)/i);
  if (androidMatch) return parseFloat(androidMatch[1]);

  const plusMatch = text.match(/(\d+\.\d+)\+/);
  if (plusMatch) return parseFloat(plusMatch[1]);

  const apiMatch = text.match(/(?:minSdk|api)\s*(\d+)/i);
  if (apiMatch) {
    const api = parseInt(apiMatch[1]);
    if (api >= 35) return 15.0;
    if (api >= 34) return 14.0;
    if (api >= 33) return 13.0;
    if (api >= 32) return 12.1; // Android 12L
    if (api >= 31) return 12.0;
    if (api >= 30) return 11.0;
    if (api >= 29) return 10.0;
    if (api >= 21) return 5.0;
    return parseFloat((api / 10).toFixed(1));
  }

  return 0;
}

/**
 * Convert an Android float version (as returned by parseAndroidVersion) to
 * its corresponding API level, for "minSdk ≤ deviceApi" compatibility checks.
 */
function androidVersionToApi(ver) {
  if (ver >= 15)  return 35;
  if (ver >= 14)  return 34;
  if (ver >= 13)  return 33;
  if (ver >= 12.1) return 32; // Android 12L
  if (ver >= 12)  return 31;
  if (ver >= 11)  return 30;
  if (ver >= 10)  return 29;
  if (ver >= 9)   return 28;
  if (ver >= 8.1) return 27;
  if (ver >= 8)   return 26;
  if (ver >= 7.1) return 25;
  if (ver >= 7)   return 24;
  if (ver >= 6)   return 23;
  if (ver >= 5.1) return 22;
  if (ver >= 5)   return 21;
  if (ver >= 4.4) return 19;
  return 0;
}

function extractArch(text) {
  const archMap = {
    "arm64-v8a": "arm64-v8a",
    "armeabi-v7a": "armeabi-v7a",
    armeabi: "armeabi-v7a",
    x86_64: "x86_64",
    x86: "x86",
    universal: "universal",
  };
  const lower = text.toLowerCase();
  for (const [key, value] of Object.entries(archMap)) {
    if (lower.includes(key.toLowerCase())) return value;
  }
  return "unknown";
}

function extractDpi(text) {
  const m = text.match(/(\d+)dpi/i);
  if (m) return m[1] + "dpi";
  if (text.toLowerCase().includes("nodpi")) return "nodpi";
  return "nodpi";
}

// ============================================================
//  Browser-based detail fetcher
// ============================================================

class ApkMirrorCrawler {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    // URLs that triggered a Cloudflare challenge during this run
    this.reviewQueue = [];
  }

  async init() {
    log("Launching browser...");
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });

    this.context = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "sec-ch-ua":
          '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Upgrade-Insecure-Requests": "1",
      },
    });

    this.page = await this.context.newPage();

    // Comprehensive fingerprint masking
    await this.page.addInitScript(() => {
      // Real browsers expose webdriver as undefined, not false
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // Headless Chromium lacks window.chrome — a primary detection signal
      window.chrome = { runtime: {} };
      // Headless has empty plugins array
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      // Fix Notification permissions behaviour
      const _origQuery = window.navigator.permissions?.query?.bind(
        window.navigator.permissions
      );
      if (_origQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : _origQuery(params);
      }
    });

    log("Browser ready.");
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      log("Browser closed.");
    }
  }

  /**
   * Navigate to url with up to maxRetries attempts and exponential back-off.
   *
   * Returns true  on success.
   * Returns false on Cloudflare challenge, 404, or exhausted retries.
   *   Cloudflare cases are appended to this.reviewQueue.
   */
  async navigateWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log(`  → ${url}  (attempt ${attempt}/${maxRetries})`);
        await this.page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        const title = await this.page.title();

        // ── Cloudflare challenge ──────────────────────────────
        if (
          title.includes("Just a moment") ||
          title.includes("Attention Required")
        ) {
          log("  ⚠️  Cloudflare challenge — waiting 30 s...");
          await sleep(30000);

          let resolved = false;
          try {
            await this.page.waitForFunction(
              () =>
                !document.title.includes("Just a moment") &&
                !document.title.includes("Attention Required"),
              { timeout: 15000 }
            );
            resolved = true;
            log("  ✅ Challenge passed.");
          } catch {
            const cur = await this.page.title().catch(() => "?");
            log(`  ⚠️  Challenge not resolved (title="${cur}") — skipping URL.`);
          }

          if (!resolved) {
            this.reviewQueue.push({ url, reason: "cloudflare_challenge" });
            return false;
          }
        }

        // ── 404 ──────────────────────────────────────────────
        const finalTitle = await this.page.title();
        if (
          finalTitle.toLowerCase().includes("page not found") ||
          finalTitle.toLowerCase().includes("404")
        ) {
          logError(`  404: ${url}`);
          return false;
        }

        return true;
      } catch (e) {
        logError(`  Navigation failed: ${e.message}`);
        if (attempt < maxRetries) {
          const backoff = 5000 * Math.pow(2, attempt - 1); // 5 s, 10 s, 20 s
          log(`  Back-off ${backoff / 1000} s before retry...`);
          await sleep(backoff);
        }
      }
    }
    return false;
  }

  /**
   * Parse the variant table from a version page.
   *
   * Three extraction strategies are tried in order:
   *   1. Structured .variants-table rows (primary)
   *   2. Alternative row selectors (.appRow / .apkRow / listWidget)
   *   3. Scan all -download/ links scoped to this release path (last resort)
   *
   * Results are cached to cache/<url-hash>.json so re-runs after a selector
   * fix replay local data without hitting the live site.
   *
   * Returns [] if the page is inaccessible or the table is empty.
   */
  async getVariants(versionUrl) {
    // ── Cache hit ─────────────────────────────────────────────
    const cached = cache.get(versionUrl);
    if (cached) {
      log(`  ↩️  Variants loaded from cache (${cache.pathFor(versionUrl)})`);
      return cached;
    }

    const ok = await this.navigateWithRetry(versionUrl);
    if (!ok) return [];

    // Wait for the variant section to actually render after any challenge
    try {
      await this.page.waitForSelector(
        '.variants-table, .table-row, .apkRow, .appRow, [class*="variant"]',
        { timeout: 10000 }
      );
    } catch {
      const title = await this.page.title().catch(() => "?");
      log(`  ⚠️  Variant section not visible within 10 s (title="${title}") — proceeding anyway.`);
    }

    // Debug: confirm we're on the right page
    const pageTitle = await this.page.title().catch(() => "?");
    log(`  Page: "${pageTitle}"`);

    try {
      // ── Method 1: structured .variants-table ──────────────────
      let variants = await this.page.$$eval(
        ".variants-table .table-row:not(.headerFont)",
        (rows) => {
          const results = [];
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll(".table-cell"));
            if (cells.length < 2) continue;
            const link =
              row.querySelector('a[href*="-download"]') ||
              row.querySelector("a.accent_color") ||
              row.querySelector('a[href*="/apk/"]');
            if (!link) continue;
            results.push({
              label: cells[0]?.textContent?.trim() || link.textContent?.trim() || "",
              arch:    cells[1]?.textContent?.trim() || "",
              android: cells[2]?.textContent?.trim() || "",
              dpi:     cells[3]?.textContent?.trim() || "",
              pageUrl: link.getAttribute("href"),
            });
          }
          return results;
        }
      ).catch(() => []);

      // ── Method 1b: alternative row-level selectors ────────────
      if (variants.length === 0) {
        variants = await this.page.$$eval(
          ".apkRow, .appRow, [class*='variant-row'], [class*='variantRow'], " +
          ".widgetInfo .table-row:not(.headerFont)",
          (rows) => {
            const results = [];
            for (const row of rows) {
              const link =
                row.querySelector('a[href*="-download"]') ||
                row.querySelector("a.accent_color");
              if (!link) continue;
              const cells = Array.from(row.querySelectorAll(".table-cell, td"));
              const rowText = row.textContent || "";
              results.push({
                label:   cells[0]?.textContent?.trim() || link.textContent?.trim() || "",
                arch:    cells[1]?.textContent?.trim() || rowText,
                android: cells[2]?.textContent?.trim() || rowText,
                dpi:     cells[3]?.textContent?.trim() || rowText,
                pageUrl: link.getAttribute("href"),
              });
            }
            return results;
          }
        ).catch(() => []);
      }

      // ── Method 2: scan -download/ links (last resort) ─────────
      if (variants.length === 0) {
        log("  Fallback: scanning -download links...");
        let releasePath = "";
        try {
          releasePath = new URL(versionUrl).pathname;
          if (!releasePath.endsWith("/")) releasePath += "/";
        } catch {}

        variants = await this.page.$$eval(
          "a",
          (links, basePath) => {
            const seen = new Set();
            const results = [];
            for (const a of links) {
              const href = a.getAttribute("href") || "";
              if (basePath && !href.startsWith(basePath)) continue;
              if (
                !href.includes("-download/") &&
                !/-(?:android-apk|apks|apk)-download\/?$/.test(href)
              ) continue;
              const clean = href.split("#")[0];
              if (seen.has(clean)) continue;
              seen.add(clean);
              const row =
                a.closest("tr, .table-row, .appRow, .apkRow") || a.parentElement;
              const rowText = row ? row.textContent : "";
              results.push({
                label:   a.textContent?.trim() || clean,
                arch:    rowText,
                android: rowText,
                dpi:     rowText,
                pageUrl: clean,
              });
            }
            return results;
          },
          releasePath
        ).catch(() => []);
      }

      // ── Normalise raw rows ────────────────────────────────────
      const parsed = variants.map((v) => ({
        label:      v.label,
        arch:       extractArch(v.arch || v.label),
        minAndroid: parseAndroidVersion(v.android || v.label),
        dpi:        extractDpi(v.dpi || v.label),
        pageUrl: v.pageUrl
          ? v.pageUrl.startsWith("http")
            ? v.pageUrl
            : BASE_URL + v.pageUrl
          : null,
      }));

      log(`  Found ${parsed.length} variant(s).`);
      for (const v of parsed) {
        log(`    • ${v.label} | arch=${v.arch} minAndroid=${v.minAndroid} dpi=${v.dpi}`);
      }

      // Persist to cache (version pages are immutable after release)
      if (parsed.length > 0) {
        cache.set(versionUrl, parsed);
      }

      return parsed;
    } catch (e) {
      logError(`  Failed to parse variants: ${e.message}`);
      return [];
    }
  }

  /**
   * Follow the APKMirror download flow to obtain a direct APK link.
   *
   * Download links expire in 24–48 h — intentionally NOT cached.
   * Returns null on failure (app falls back to download_page_url).
   */
  async getDirectDownloadUrl(variantPageUrl) {
    const ok = await this.navigateWithRetry(variantPageUrl);
    if (!ok) return null;

    try {
      const downloadBtnSelectors = [
        "a.accent_bg.btn-flat.downloadButton",
        "a.downloadButton",
        'a[href*="-download/"]',
        'a[href*="download/?key="]',
        ".card-with-tabs a.accent_bg",
      ];

      let downloadPageUrl = null;

      for (const sel of downloadBtnSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn) {
            const href = await btn.getAttribute("href");
            if (!href || href.startsWith("#")) continue;
            if (href.includes("download")) {
              downloadPageUrl = href.startsWith("http")
                ? href
                : BASE_URL + href;
              break;
            }
          }
        } catch {
          continue;
        }
      }

      if (!downloadPageUrl) {
        downloadPageUrl = await this.page.$$eval("a", (links) => {
          for (const a of links) {
            const href = a.getAttribute("href") || "";
            const text = a.textContent || "";
            if (href.includes("/download/") && href.includes("?key=")) return href;
            if (text.includes("Download APK") && href.includes("/apk/")) return href;
            if (href.includes("-download/") && href.includes("/apk/")) return href;
          }
          return null;
        });
        if (downloadPageUrl && !downloadPageUrl.startsWith("http")) {
          downloadPageUrl = BASE_URL + downloadPageUrl;
        }
      }

      if (!downloadPageUrl) {
        logError("    No download button found.");
        return null;
      }

      log(`    Entering download page: ${downloadPageUrl}`);
      await sleep(DELAY_BETWEEN_PAGES);

      const ok2 = await this.navigateWithRetry(downloadPageUrl);
      if (!ok2) return null;

      // APKMirror shows a 5-second countdown before the real link appears
      log("    Waiting for countdown...");
      await sleep(6000);

      const directUrl = await this.page.$$eval("a", (links) => {
        for (const a of links) {
          const href = a.getAttribute("href") || "";
          if (href.includes("download.php?id=")) return href;
        }
        for (const a of links) {
          const rel = a.getAttribute("rel") || "";
          const href = a.getAttribute("href") || "";
          if (rel.includes("nofollow") && href.includes("/wp-content/")) return href;
        }
        return null;
      });

      if (directUrl) {
        const full = directUrl.startsWith("http") ? directUrl : BASE_URL + directUrl;
        log("    ✅ Direct URL obtained.");
        return full;
      }

      // Last resort: click-triggered link
      try {
        const btn = await this.page.$(
          'a[rel="nofollow"][data-google-vignette="false"]'
        );
        if (btn) {
          const href = await btn.getAttribute("href");
          if (href) {
            log("    ✅ Direct URL obtained via click.");
            return href.startsWith("http") ? href : BASE_URL + href;
          }
        }
      } catch {}

      logError("    No direct download link found.");
      return null;
    } catch (e) {
      logError(`    getDirectDownloadUrl failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Choose the single best variant for a target device from a parsed list.
   *
   * Compatibility rule: variantMinApi ≤ target.deviceApi
   *   → "Android 12+" (API 31) IS compatible with an Android 14 (API 34) device.
   *
   * Priority (descending):
   *   1. Arch score: exact match (3) > universal/noarch (2) > unknown (1) > 0 (incompatible)
   *   2. minAndroid: higher preferred (more specific to device, smaller download)
   *   3. APK preferred over bundle when scores are equal
   *
   * Returns the best variant object, or null when no compatible variant exists.
   */
  chooseBestVariant(variants, target) {
    const archScore = (variantArch) => {
      if (variantArch === target.arch)                         return 3;
      if (variantArch === "universal" || variantArch === "noarch") return 2;
      if (variantArch === "unknown")                           return 1;
      return 0;
    };

    const candidates = variants.filter((v) => {
      if (archScore(v.arch) === 0) return false;
      const variantMinApi = androidVersionToApi(v.minAndroid);
      return variantMinApi <= target.deviceApi;
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const as = archScore(a.arch), bs = archScore(b.arch);
      if (as !== bs) return bs - as;
      // Higher minAndroid = closer to device = prefer
      if (b.minAndroid !== a.minAndroid) return b.minAndroid - a.minAndroid;
      return 0;
    });

    return candidates[0];
  }
}

// ============================================================
//  Main — two-phase orchestration
// ============================================================

async function main() {
  const configPath = path.join(__dirname, "..", "config", "packages.json");
  const outputPath = path.join(__dirname, "..", "variants.json");

  if (!fs.existsSync(configPath)) {
    logError(`Config not found: ${configPath}`);
    process.exit(1);
  }

  const { packages } = JSON.parse(fs.readFileSync(configPath, "utf8"));

  // Seed result from existing variants.json so unchanged packages are preserved
  let baseline = { packages: {} };
  if (fs.existsSync(outputPath)) {
    try {
      baseline = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch {}
  }

  const result = {
    config_version: 2,
    updated_at: new Date().toISOString().slice(0, 10),
    generated_by: "gms-config-crawler",
    packages: { ...(baseline.packages || {}) },
  };

  const crawler = new ApkMirrorCrawler();
  let browserStarted = false;

  try {
    for (const pkg of packages) {
      log(`\n${"=".repeat(60)}`);
      log(`Package: ${pkg.name} (${pkg.package_name})`);
      log("=".repeat(60));

      // ── Phase 1: Discovery — no browser ──────────────────────
      const pkgState = stateStore.getPackage(pkg.id);
      log(`  Last known version: ${pkgState.lastVersion || "(none)"}`);

      const disc = await discovery.discoverNewVersions(pkg, pkgState.lastVersion);

      if (disc.error) {
        logError(`  Discovery failed: ${disc.error} — retaining existing data.`);
        continue;
      }

      if (disc.newVersions.length === 0) {
        log(`  ✅ Already up-to-date (${pkgState.lastVersion}) — skipping browser.`);
        continue;
      }

      log(
        `  🆕 ${disc.newVersions.length} new version(s): ` +
          disc.newVersions.map((v) => v.version).join(", ") +
          (disc.discoverySource ? `  [via ${disc.discoverySource}]` : "")
      );

      // ── Phase 2: Detail extraction — browser only if needed ──
      if (!browserStarted) {
        await crawler.init();
        browserStarted = true;
      }

      const packageVariants = [];
      const processedUrls = new Set(); // avoid re-fetching the same APK download page

      // ── Phase 2a: fetch each release URL ONCE, cache variants in memory ──
      //   Never re-open the same page per-target — that triggers challenge loops.
      log("\n  Pre-fetching variant tables (one fetch per release URL)...");
      const versionVariantMap = new Map();
      for (const versionInfo of disc.newVersions) {
        if (versionVariantMap.has(versionInfo.url)) continue;
        await sleep(DELAY_BETWEEN_PAGES);
        const variants = await crawler.getVariants(versionInfo.url);
        versionVariantMap.set(versionInfo.url, variants);
        log(
          `  📦 ${versionInfo.version}: ${variants.length} variant(s) cached.`
        );
      }

      // ── Phase 2b: match targets locally — no additional browser fetches ──
      for (const target of TARGET_COMBINATIONS) {
        log(`\n  Target: ${target.label}`);
        let foundMatch = false;

        for (const versionInfo of disc.newVersions) {
          const allVariants = versionVariantMap.get(versionInfo.url) || [];

          if (allVariants.length === 0) {
            log(`    ${versionInfo.version}: no variants — skipping.`);
            continue;
          }

          const best = crawler.chooseBestVariant(allVariants, target);
          if (!best) {
            log(`    ${versionInfo.version}: no compatible variant for ${target.label}.`);
            continue;
          }

          // Reuse already-fetched direct URL when the same APK serves multiple targets
          if (processedUrls.has(best.pageUrl)) {
            const existing = packageVariants.find(
              (v) => v.download_page_url === best.pageUrl
            );
            if (existing) {
              packageVariants.push({
                ...existing,
                variant_label: `${versionInfo.version} / ${target.label}`,
                min_api: target.minApi,
                max_api: target.maxApi,
              });
            }
            foundMatch = true;
            break;
          }

          if (!best.pageUrl) {
            log("    Variant has no page URL — skipping.");
            continue;
          }

          processedUrls.add(best.pageUrl);
          log(
            `    Best match: ${best.label}` +
              `  arch=${best.arch}  minAndroid=${best.minAndroid}+  dpi=${best.dpi}`
          );

          await sleep(DELAY_BETWEEN_VARIANTS);
          const directUrl = await crawler.getDirectDownloadUrl(best.pageUrl);

          packageVariants.push({
            variant_label: `${versionInfo.version} / ${target.label}`,
            version: versionInfo.version,
            min_api: target.minApi,
            max_api: target.maxApi,
            abis:
              best.arch === "universal" || best.arch === "noarch" || best.arch === "unknown"
                ? ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"]
                : [target.arch],
            dpi: best.dpi,
            file_size_mb: pkg.approx_size_mb || 50,
            download_page_url: best.pageUrl,
            direct_url: directUrl,
            sha256: null,
          });

          log(
            `    Result: ${directUrl ? "✅ has direct URL" : "⚠️  no direct URL (will fall back to web)"}`
          );
          foundMatch = true;
          break;
        }

        if (!foundMatch) {
          log(`  ⚠️  No match found for ${target.label}`);
        }
      }

      if (packageVariants.length > 0) {
        result.packages[pkg.id] = {
          name: pkg.name,
          package_name: pkg.package_name,
          version: disc.latestVersion,
          install_order: pkg.install_order,
          variants: packageVariants,
        };
        // Only advance state when we successfully produced variants
        stateStore.updatePackage(pkg.id, { lastVersion: disc.latestVersion });
        log(`\n  ✅ ${pkg.name} updated — ${packageVariants.length} variant(s).`);
      } else {
        log(`\n  ⚠️  ${pkg.name}: no variants produced — retaining existing data.`);
        // Do NOT update state so next run retries
      }
    }

    // ── Write outputs ─────────────────────────────────────────
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
    log(`\n✅ Written: ${outputPath}`);

    let total = 0, withUrl = 0;
    for (const pkg of Object.values(result.packages)) {
      for (const v of pkg.variants || []) {
        total++;
        if (v.direct_url) withUrl++;
      }
    }
    log(`   Variants: ${total}  |  With direct URL: ${withUrl}  |  Without: ${total - withUrl}`);

    // Flush review queue collected during this run
    for (const item of crawler.reviewQueue) {
      stateStore.addToReviewQueue(item);
    }
    if (crawler.reviewQueue.length > 0) {
      log(
        `\n⚠️  ${crawler.reviewQueue.length} URL(s) added to review_queue in config/state.json`
      );
    }
  } catch (e) {
    logError(`Fatal: ${e.message}`);
    console.error(e);
    process.exit(1);
  } finally {
    if (browserStarted) await crawler.close();
  }
}

main();
