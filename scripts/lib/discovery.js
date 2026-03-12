/**
 * Discovery layer — uses APKMirror RSS feeds (plain HTTPS, no browser).
 *
 * Each package exposes a public feed at:
 *   https://www.apkmirror.com/apk/{apkmirror_path}/feed/
 *
 * Comparing the latest RSS entry against the saved state lets us decide
 * whether to start the browser at all.  Typical steady-state: 0 new
 * versions → browser never launched → 0 Cloudflare challenges.
 *
 * Fallback: if the RSS feed returns 403 / is unavailable, we try to
 * scrape the package listing page directly (plain HTTPS, no browser).
 * The listing page may also be blocked but is worth one attempt before
 * giving up and retaining the existing data.
 */

"use strict";

const https = require("https");
const http = require("http");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

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

  // ── Strategy 2: package listing page (RSS unavailable) ────────
  if (!all) {
    console.log(
      `  ⚠️  RSS unavailable (${rssError}) — trying package listing page…`
    );
    const fallback = await discoverViaPackagePage(pkg);
    if (fallback) {
      all = fallback;
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
