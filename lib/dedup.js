/**
 * Posting dedup + merge.
 *
 * Three passes:
 *   1. URL-exact: merge postings sharing any canonicalUrl or alternateUrl.
 *   2. Exact dedupKey: merge on sha1(company-slug, role-normalized, location).
 *   3. MinHash LSH fuzzy: merge near-duplicates with Jaccard >= 0.70 on
 *      BIGRAM-shingled (company + title + primary-location) text.
 *
 * The third pass catches cases the sha1 key misses: "Senior ML Engineer"
 * vs "Sr. Machine Learning Engineer - NLP", or slugs like "scaleai" vs
 * "scale-ai". Empirical backing: LSHBloom (arXiv 2411.04257, 2024);
 * datasketch production-defaults (128 perms, 18 x 7 banding = 126 of 128
 * permutations used). NOTE: this caller overrides the minhash.js module
 * defaults (shingle k=3, threshold 0.80) with k=2 bigrams and a 0.70
 * threshold, because job-posting text is short (~10-15 tokens) and trigrams
 * make single-word edits collapse the Jaccard similarity.
 *
 * Provenance: `discoveredVia` arrays from every source merged into the
 * surviving posting; the best URL (by URL_PREFERENCE) becomes canonicalUrl.
 */

const { preferUrl, parseLocation } = require('./posting');
const { MinHashLSH, minhashOf } = require('./minhash');

function mergePostings(a, b) {
  const allUrls = new Set([...a.alternateUrls, ...b.alternateUrls, a.canonicalUrl, b.canonicalUrl]);
  const canonicalUrl = [...allUrls].reduce((best, next) => preferUrl(best, next));
  allUrls.delete(canonicalUrl);

  const latest = (x, y, key) => {
    if (x[key] && y[key]) return new Date(x[key]) > new Date(y[key]) ? x[key] : y[key];
    return x[key] || y[key];
  };

  return {
    ...a,
    canonicalUrl,
    alternateUrls: [canonicalUrl, ...allUrls],
    postedDate: latest(a, b, 'postedDate'),
    jdText: a.jdText || b.jdText,
    jdHtml: a.jdHtml || b.jdHtml,
    compensation: a.compensation || b.compensation,
    department: a.department || b.department,
    discoveredVia: [...a.discoveredVia, ...b.discoveredVia],
  };
}

function postingFuzzyText(p) {
  const locPrimary = parseLocation(p.location || '').primary || '';
  return `${p.company} ${p.title} ${locPrimary}`.toLowerCase();
}

function dedup(postings, { jaccardThreshold = 0.70 } = {}) {
  // Pass 1: URL exact
  const byUrl = new Map();
  for (const p of postings) {
    const urls = [p.canonicalUrl, ...p.alternateUrls];
    let merged = p;
    const existingKeys = new Set();
    for (const u of urls) {
      const hit = byUrl.get(u);
      if (hit && hit !== merged) {
        merged = mergePostings(merged, hit);
        existingKeys.add(hit.canonicalUrl);
      }
    }
    for (const k of existingKeys) {
      for (const u of (byUrl.get(k)?.alternateUrls || [])) byUrl.delete(u);
      byUrl.delete(k);
    }
    for (const u of [merged.canonicalUrl, ...merged.alternateUrls]) {
      byUrl.set(u, merged);
    }
  }
  const urlDeduped = [...new Set(byUrl.values())];

  // Pass 2: exact dedupKey (company-slug + role-normalized + primary-location)
  const byKey = new Map();
  for (const p of urlDeduped) {
    const existing = byKey.get(p.dedupKey);
    byKey.set(p.dedupKey, existing ? mergePostings(existing, p) : p);
  }
  const keyDeduped = [...byKey.values()];

  // Pass 3: MinHash LSH fuzzy merge.
  // Use bigram shingles (k=2) because job-posting text is short (title +
  // company + location ~= 10-15 tokens); trigrams make 1-word insertions
  // catastrophically reduce Jaccard.
  const lsh = new MinHashLSH({ threshold: jaccardThreshold });
  const signatures = new Map();
  for (let i = 0; i < keyDeduped.length; i++) {
    const mh = minhashOf(postingFuzzyText(keyDeduped[i]), { k: 2 });
    signatures.set(i, mh);
    lsh.insert(i, mh);
  }

  const parent = new Int32Array(keyDeduped.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(x, y) { const rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry; }

  for (let i = 0; i < keyDeduped.length; i++) {
    const mh = signatures.get(i);
    for (const hit of lsh.query(mh)) {
      if (hit.id !== i) {
        // Require same canonical company before merging (company name is the
        // most reliable anchor; two different companies with similar titles
        // must NOT be collapsed).
        if (keyDeduped[i].companySlug === keyDeduped[hit.id].companySlug) {
          union(i, hit.id);
        }
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < keyDeduped.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(keyDeduped[i]);
  }

  const out = [];
  for (const group of groups.values()) {
    let merged = group[0];
    for (let i = 1; i < group.length; i++) merged = mergePostings(merged, group[i]);
    out.push(merged);
  }
  return out;
}

module.exports = { dedup, mergePostings, postingFuzzyText };
