/**
 * Discovery layer — three strategies, tried in order (all plain HTTPS, no browser).
 *
 * Strategy 1 — RSS feed  (preferred)
 *   https://www.apkmirror.com/apk/{apkmirror_path}/feed/
 *   Rich version titles, fast.  Returns HTTP 403 for some packages.
 *
 * Strategy 2 — Sitemap  (robots.txt canonical entry point)
 *   APKMirror's robots.txt explicitly lists:
 *     Sitemap: https://www.apkmirror.com/sitemap_index.xml
 *   We fetch the index, locate the sub-sitemap that contains the package
 *   path, then extract release URLs.  More authorised than scraping the
 *   listing page but requires two HTTP round-trips.
 *
 * Strategy 3 — Package listing page  (last resort)
 *   https://www.apkmirror.com/apk/{apkmirror_path}/
 *   Regex-extracts -release/ hrefs directly from the HTML.
 *
 * robots.txt compliance (https://www.apkmirror.com/robots.txt):
 *   Crawl-delay: 3  (respected in crawl.js via DELAY_BETWEEN_PAGES = 3000 ms)
 *   Disallow: *\/comment-page-1*  (filtered in crawl.js navigateWithRetry)
 *   Disallow: /wp-content/themes/APKMirror/download.php  (filtered in crawl.js)
 */

"use strict";

const https = require("https");
const http = require("http");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Canonical sitemap entry from APKMirror's robots.txt
const SITEMAP_INDEX_URL = "https://www.apkmirror.com/sitemap_index.xml";

// ---------------------------------------------------------------
// Internal: plain HTTPS GET with redirect following
// ---------------------------------------------------------------
function get(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error("Too many redirects"));
    }
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/rss+xml,application/xml,text/xml,*/*",
        },
        timeout: 20000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return resolve(get(res.headers.location, redirectCount + 1));
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} — ${url}`));
          return;
        }
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

// ---------------------------------------------------------------
// Internal: parse RSS XML → [{version, url}] newest-first
// ---------------------------------------------------------------
function parseRss(xml, packagePath) {
  const versions = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;

  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[1];

    // Title may be plain text or CDATA-wrapped
    const title = (
      item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
      item.match(/<title>([\s\S]*?)<\/title>/)
    )?.[1]?.trim();

    // Prefer <link>, fall back to permalink <guid>
    const link = (
      item.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/) ||
      item.match(
        /<guid[^>]*isPermaLink="true"[^>]*>([\s\S]*?)<\/guid>/
      )
    )?.[1]?.trim();

    if (!title || !link) continue;

    // Skip pre-release builds
    const lower = title.toLowerCase();
    if (
      lower.includes("beta") ||
      lower.includes("alpha") ||
      lower.includes("canary") ||
      lower.includes("preview")
    ) {
      continue;
    }

    // Must be a stable-release page for this exact package
    if (
      !link.includes(`/apk/${packagePath}/`) ||
      !link.includes("-release/")
    ) {
      continue;
    }

    versions.push({ version: title, url: link });
  }

  return versions;
}

// ---------------------------------------------------------------
// Internal: sitemap-based discovery (robots.txt canonical source)
// ---------------------------------------------------------------

/**
 * Parse <loc> elements from an XML sitemap or sitemap index.
 * Returns an array of URL strings.
 */
function parseSitemapLocs(xml) {
  const locs = [];
  const re = /<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(m[1]);
  return locs;
}

/**
 * Strategy 2: discover releases via sitemap_index.xml (no browser).
 *
 * Workflow:
 *   1. Fetch sitemap_index.xml → list of sub-sitemap URLs.
 *   2. For each sub-sitemap whose URL mentions the package path (fast
 *      pre-filter), fetch and scan for -release/ entries.
 *   3. Stop after the first sub-sitemap that yields results (most packages
 *      live in a single sub-sitemap).
 *
 * Returns [{version, url}] newest-first, or null on failure.
 */
async function discoverViaSitemap(pkg) {
  try {
    const indexXml = await get(SITEMAP_INDEX_URL);
    const subSitemaps = parseSitemapLocs(indexXml);
    if (subSitemaps.length === 0) return null;

    // The package's slug (last component of apkmirror_path) is usually present
    // in the sub-sitemap URL or at minimum in its content.
    const pkgSlug = pkg.apkmirror_path.split("/").pop();
    const pkgPath = pkg.apkmirror_path;

    for (const sitemapUrl of subSitemaps) {
      // Quick pre-filter: skip sitemaps whose URL clearly can't contain this pkg
      // (e.g. sitemaps named after unrelated categories/letters).
      // We can't reliably pre-filter by URL alone, so we just try each one but
      // abort early once we find a match to avoid excessive requests.
      let sitemapXml;
      try {
        sitemapXml = await get(sitemapUrl);
      } catch {
        continue;
      }

      // Skip sub-sitemaps that don't mention this package at all
      if (!sitemapXml.includes(pkgSlug) && !sitemapXml.includes(pkgPath)) {
        continue;
      }

      const versions = [];
      const seen = new Set();

      for (const url of parseSitemapLocs(sitemapXml)) {
        if (!url.includes(pkgPath) || !url.includes("-release/")) continue;
        const lower = url.toLowerCase();
        if (
          lower.includes("beta") ||
          lower.includes("alpha") ||
          lower.includes("canary") ||
          lower.includes("preview")
        ) continue;
        if (seen.has(url)) continue;
        seen.add(url);

        const slugMatch = url.match(/\/([^/]+)-release\/?$/);
        if (!slugMatch) continue;
        const digits = slugMatch[1].match(/(\d[\d.-]*)$/);
        const version = digits ? digits[1].replace(/-/g, ".") : slugMatch[1];
        versions.push({ version, url });
      }

      if (versions.length > 0) return versions;
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// Internal: scrape the package listing page for recent release links
// ---------------------------------------------------------------

/**
 * Fallback discovery: parse the package listing page (plain HTTPS).
 * Returns [{version, url}] newest-first, or null on failure.
 *
 * The version string extracted from the URL slug is less readable than
 * the RSS title but sufficient for state comparison.
 */
async function discoverViaPackagePage(pkg) {
  const pageUrl = `https://www.apkmirror.com/apk/${pkg.apkmirror_path}/`;
  try {
    const html = await get(pageUrl);

    // Extract hrefs like /apk/{path}/some-name-release/ from anchor tags
    const linkRe = new RegExp(
      `href="(/apk/${pkg.apkmirror_path.replace(/\//g, "\\/")}` +
        `/[^"]*-release/)"`,
      "g"
    );

    const versions = [];
    const seen = new Set();
    let m;

    while ((m = linkRe.exec(html)) !== null) {
      const relPath = m[1];
      if (seen.has(relPath)) continue;
      seen.add(relPath);

      const lower = relPath.toLowerCase();
      if (
        lower.includes("beta") ||
        lower.includes("alpha") ||
        lower.includes("canary") ||
        lower.includes("preview")
      ) continue;

      // Extract a version string from the last path segment before "-release/"
      // e.g. /apk/…/google-play-store-50-4-17-release/ → "50.4.17"
      const slugMatch = relPath.match(/\/([^/]+)-release\/?$/);
      if (!slugMatch) continue;

      // Grab the trailing digit sequence from the slug as version
      const digits = slugMatch[1].match(/(\d[\d.-]*)$/);
      const version = digits
        ? digits[1].replace(/-/g, ".")
        : slugMatch[1];

      versions.push({
        version,
        url: `https://www.apkmirror.com${relPath}`,
      });
    }

    return versions.length > 0 ? versions : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Check for new versions of a package.
 *
 * Strategy 1: RSS feed (preferred — rich version strings, no Cloudflare).
 * Strategy 2: Package listing page (fallback when RSS returns 403 / empty).
 *
 * @param {object} pkg              Package row from packages.json
 * @param {string|null} lastVersion Last version string saved in state.json
 *
 * @returns {{ newVersions: Array<{version,url}>, latestVersion: string,
 *             discoverySource: string }}
 *           on success — newVersions is empty when nothing changed
 *          {{ error: string }}
 *           on failure — caller should skip and retain existing data
 */
async function discoverNewVersions(pkg, lastVersion) {
  // ── Strategy 1: RSS ───────────────────────────────────────────
  const feedUrl = `https://www.apkmirror.com/apk/${pkg.apkmirror_path}/feed/`;
  let all = null;
  let rssError = null;
  let discoverySource = "rss";

  try {
    const xml = await get(feedUrl);
    const parsed = parseRss(xml, pkg.apkmirror_path);
    if (parsed.length > 0) {
      all = parsed;
    } else {
      rssError = "RSS returned no usable release entries";
    }
  } catch (e) {
    rssError = e.message;
  }

  // ── Strategy 2: sitemap (robots.txt canonical source) ────────
  if (!all) {
    console.log(
      `  ⚠️  RSS unavailable (${rssError}) — trying sitemap_index.xml…`
    );
    const fromSitemap = await discoverViaSitemap(pkg);
    if (fromSitemap) {
      all = fromSitemap;
      discoverySource = "sitemap";
      console.log(`  ↩️  Sitemap yielded ${all.length} release(s).`);
    }
  }

  // ── Strategy 3: package listing page (last resort) ────────────
  if (!all) {
    console.log("  ⚠️  Sitemap yielded nothing — trying package listing page…");
    const fromListing = await discoverViaPackagePage(pkg);
    if (fromListing) {
      all = fromListing;
      discoverySource = "listing";
      console.log(`  ↩️  Package listing page yielded ${all.length} release(s).`);
    }
  }

  if (!all || all.length === 0) {
    return { error: rssError || "No releases found via any discovery source" };
  }

  const latestVersion = all[0].version;

  if (!lastVersion) {
    return { newVersions: [all[0]], latestVersion, discoverySource };
  }

  if (latestVersion === lastVersion) {
    return { newVersions: [], latestVersion, discoverySource };
  }

  // Return every version newer than lastVersion (cap at 3 to avoid bursts)
  const cutIdx = all.findIndex((v) => v.version === lastVersion);
  const newVersions = cutIdx > 0 ? all.slice(0, cutIdx) : [all[0]];
  return { newVersions: newVersions.slice(0, 3), latestVersion, discoverySource };
}

module.exports = { discoverNewVersions };
