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

// minApi / maxApi are the values written directly into variants.json.
// Android version → API level mapping:
//   14+  → 34 / null   (no upper bound)
//   13   → 33 / 33
//   12   → 31 / 32     (includes 12L, API 32)
//   11   → 30 / 30
//   armv7/11+ → 30 / null  (covers all armv7 devices regardless of Android ver)
const TARGET_COMBINATIONS = [
  { arch: "arm64-v8a",   minAndroid: "14.0", minApi: 34, maxApi: null, label: "arm64-v8a / Android 14+" },
  { arch: "arm64-v8a",   minAndroid: "13.0", minApi: 33, maxApi: 33,   label: "arm64-v8a / Android 13"  },
  { arch: "arm64-v8a",   minAndroid: "12.0", minApi: 31, maxApi: 32,   label: "arm64-v8a / Android 12"  },
  { arch: "arm64-v8a",   minAndroid: "11.0", minApi: 30, maxApi: 30,   label: "arm64-v8a / Android 11"  },
  { arch: "armeabi-v7a", minAndroid: "11.0", minApi: 30, maxApi: null, label: "armv7 / Android 11+"     },
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
 * Parse "Android 14.0+" / "5.0+" / "minSdk 33" style strings into a number.
 * Returns 0 when nothing is recognised (= no Android version restriction).
 */
function parseAndroidVersion(text) {
  const androidMatch = text.match(/android\s+(\d+(?:\.\d+)?)/i);
  if (androidMatch) return parseFloat(androidMatch[1]);

  const plusMatch = text.match(/(\d+\.\d+)\+/);
  if (plusMatch) return parseFloat(plusMatch[1]);

  const apiMatch = text.match(/(?:minSdk|api)\s*(\d+)/i);
  if (apiMatch) {
    const api = parseInt(apiMatch[1]);
    if (api >= 34) return 14.0;
    if (api >= 33) return 13.0;
    if (api >= 31) return 12.0;
    if (api >= 30) return 11.0;
    if (api >= 21) return 5.0;
    return parseFloat((api / 10).toFixed(1));
  }

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

    try {
      // Method 1: structured variants-table
      let variants = await this.page.$$eval(
        ".variants-table .table-row",
        (rows) => {
          const results = [];
          for (const row of rows) {
            if (row.classList.contains("headerFont")) continue;
            const cells = row.querySelectorAll(".table-cell");
            const link =
              row.querySelector('a[href*="-download"]') ||
              row.querySelector("a.accent_color");
            if (!link) continue;
            results.push({
              label: cells[0]?.textContent?.trim() || link.textContent?.trim() || "",
              arch: cells[1]?.textContent?.trim() || "",
              android: cells[2]?.textContent?.trim() || "",
              dpi: cells[3]?.textContent?.trim() || "",
              pageUrl: link.getAttribute("href"),
            });
          }
          return results;
        }
      );

      // Method 2: scan for -download/ links scoped to this release path
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
                a.closest("tr, .table-row, .appRow") || a.parentElement;
              const rowText = row ? row.textContent : "";
              results.push({
                label: a.textContent?.trim() || clean,
                arch: rowText,
                android: rowText,
                dpi: rowText,
                pageUrl: clean,
              });
            }
            return results;
          },
          releasePath
        );
      }

      const parsed = variants.map((v) => ({
        label: v.label,
        arch: extractArch(v.arch),
        minAndroid: parseAndroidVersion(v.android),
        dpi: extractDpi(v.dpi),
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
   * Select variants from a parsed list that match an arch + minAndroid target.
   * Accepts "universal" and "unknown" (single-APK packages) as arch wildcards.
   */
  filterBestVariant(variants, target) {
    return variants.filter((v) => {
      const archOk =
        v.arch === target.arch || v.arch === "universal" || v.arch === "unknown";
      if (!archOk) return false;
      if (v.minAndroid > parseFloat(target.minAndroid)) return false;
      return true;
    });
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
        logError(`  RSS discovery failed: ${disc.error} — retaining existing data.`);
        continue;
      }

      if (disc.newVersions.length === 0) {
        log(`  ✅ Already up-to-date (${pkgState.lastVersion}) — skipping browser.`);
        continue;
      }

      log(
        `  🆕 ${disc.newVersions.length} new version(s): ` +
          disc.newVersions.map((v) => v.version).join(", ")
      );

      // ── Phase 2: Detail extraction — browser only if needed ──
      if (!browserStarted) {
        await crawler.init();
        browserStarted = true;
      }

      const packageVariants = [];
      const processedUrls = new Set(); // avoid re-fetching the same APK page

      for (const target of TARGET_COMBINATIONS) {
        log(`\n  Target: ${target.label}`);
        let foundMatch = false;

        for (const versionInfo of disc.newVersions) {
          await sleep(DELAY_BETWEEN_PAGES);
          const allVariants = await crawler.getVariants(versionInfo.url);

          if (allVariants.length === 0) {
            log(`    ${versionInfo.version}: no variants (blocked or parse failure).`);
            continue;
          }

          const matched = crawler.filterBestVariant(allVariants, target);
          if (matched.length === 0) {
            log(`    ${versionInfo.version}: no matching variant.`);
            continue;
          }

          const best = matched[0];

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
              `  arch=${best.arch}  Android ${best.minAndroid}+  dpi=${best.dpi}`
          );

          await sleep(DELAY_BETWEEN_VARIANTS);
          const directUrl = await crawler.getDirectDownloadUrl(best.pageUrl);

          packageVariants.push({
            variant_label: `${versionInfo.version} / ${target.label}`,
            version: versionInfo.version,
            min_api: target.minApi,
            max_api: target.maxApi,
            abis:
              target.arch === "universal" || best.arch === "unknown"
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
