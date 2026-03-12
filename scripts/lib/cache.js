/**
 * File-based cache for parsed variant results.
 *
 * A version page's variant table never changes after release, so parsed
 * results can be cached indefinitely.  Cache is keyed by the URL's MD5
 * hash and stored under cache/<hash>.json.
 *
 * During testing / selector updates, delete the relevant cache files
 * (or run `rm cache/*.json`) to force a fresh parse without re-hitting
 * the live site.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = path.join(__dirname, "../../cache");

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheFile(url) {
  const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
  return path.join(CACHE_DIR, `${hash}.json`);
}

/**
 * Return cached parsed data for a URL, or null if not cached.
 * @param {string} url
 * @returns {any|null}
 */
function get(url) {
  ensureDir();
  const file = cacheFile(url);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Save parsed data for a URL.
 * @param {string} url
 * @param {any} data
 */
function set(url, data) {
  ensureDir();
  fs.writeFileSync(cacheFile(url), JSON.stringify(data, null, 2), "utf8");
}

/** Invalidate the cache for a specific URL. */
function invalidate(url) {
  const file = cacheFile(url);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Return cache file path for a URL (useful for logging). */
function pathFor(url) {
  return cacheFile(url);
}

module.exports = { get, set, invalidate, pathFor };
