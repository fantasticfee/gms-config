/**
 * Incremental state manager.
 *
 * Persists to config/state.json:
 * {
 *   "<pkgId>": {
 *     "lastVersion": "...",   // last version successfully written to variants.json
 *     "lastChecked": "YYYY-MM-DD"
 *   },
 *   "review_queue": [
 *     { "url": "...", "reason": "cloudflare_challenge", "date": "YYYY-MM-DD" }
 *   ]
 * }
 */

"use strict";

const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "../../config/state.json");

function read() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function write(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/** Get state for one package. */
function getPackage(pkgId) {
  return read()[pkgId] || { lastVersion: null, lastChecked: null };
}

/** Merge patches into state for one package and persist. */
function updatePackage(pkgId, patches) {
  const state = read();
  state[pkgId] = {
    ...(state[pkgId] || {}),
    ...patches,
    lastChecked: new Date().toISOString().slice(0, 10),
  };
  write(state);
}

/**
 * Append an entry to the review_queue (e.g. Cloudflare challenge, parse error).
 * Deduplicates by url+date.  Keeps the last 100 entries.
 */
function addToReviewQueue(entry) {
  const state = read();
  state.review_queue = state.review_queue || [];

  const today = new Date().toISOString().slice(0, 10);
  const isDup = state.review_queue.some(
    (e) => e.url === entry.url && e.date === today
  );
  if (!isDup) {
    state.review_queue.push({ ...entry, date: today });
    if (state.review_queue.length > 100) {
      state.review_queue = state.review_queue.slice(-100);
    }
    write(state);
  }
}

module.exports = { read, write, getPackage, updatePackage, addToReviewQueue };
