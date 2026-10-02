/**
 * Posting dedup + merge.
 *
 * Three passes:
 *   1. URL-exact: merge postings sharing any canonicalUrl or alternateUrl.
 *   2. Exact dedupKey: merge on sha1(company-slug, role-normalized); location
 *      is left out so one req listed in several places collapses. With
 *      `byLocation` (the caller's policy accepts onsite or hybrid work) the
 *      city is part of the merge, so the same title in two cities stays two
 *      rows.
 *   3. MinHash LSH fuzzy: merge near-duplicates with Jaccard >= 0.70 on
 *      BIGRAM-shingled (company + title + primary-location) text.
 *
 * The third pass catches cases the sha1 key misses: "Senior Tax Accountant"
 * vs "Sr. Tax Accountant - Corporate", or slugs like "acmehealth" vs
 * "acme-health". Empirical backing: LSHBloom (arXiv 2411.04257, 2024);
 * datasketch production-defaults (128 perms, 18 x 7 banding = 126 of 128
 * permutations used). NOTE: this caller overrides the minhash.js module
 * defaults (shingle k=3, threshold 0.80) with k=2 bigrams and a 0.70
 * threshold, because job-posting text is short (~10-15 tokens) and trigrams
 * make single-word edits collapse the Jaccard similarity.
 *
 * Provenance: `discoveredVia` arrays from every source merged into the
 * surviving posting; the best URL (by URL_PREFERENCE) becomes canonicalUrl.
 */

const crypto = require('crypto');
const { preferUrl, parseLocation, textClean, US_STATE_NAMES } = require('./posting');
const { namedCountries, namesNoCity, isRegion } = require('./profile');
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

// The place a posting is in, for the byLocation merge: the city, so "Toronto,
// ON" and "Toronto, Ontario, Canada" from two sources still merge. A location
// with no city (remote, a country alone, or empty) is one place per country:
// every wording of a remote job is the same job. A remote location in the US
// that also names a city ("New York, NY (Remote)") counts as remote. A hybrid
// location with no city is its own place, so it never absorbs the remote row.
// In a US location a segment that reads as a country is the town or state of
// that name ("Lebanon, NH", "Georgia, United States"), and a state or
// province name is a place in any location ("New Jersey").
// ponytail: US and country unknown share the place "remote". A remote row
// the classifier does not place in the US keeps its own first place token as
// the key ("Calgary (Remote)", "Remote (CAN)", "Europe (Remote)"), so it never
// merges into the US remote row and still reaches the country gate; the cost
// is that two wordings of one such place ("Remote, Canada" and "Remote (CAN)")
// stay two rows. A location in a non Latin script arrives empty (see
// lib/posting.js) and so reads as "remote". Upgrade path: a normalized place
// id on Posting.
function place(p) {
  const l = parseLocation(p.location || '');
  const segs = l.raw.split(/\s*[,;:|()/]\s*/).filter(Boolean);
  // The classifier reads a state name only after a comma and only when no
  // work mode is written ("New York, New York (Remote)" is unknown to it).
  const us = l.us === true || (l.us === null && segs.some((seg) => US_STATE_NAMES.has(seg.toLowerCase())));
  // A state or province code is not the city ("US, CA, Santa Clara").
  const city = segs.find((seg) => (/^[A-Z]{2,3}$/.test(seg)
    ? !isRegion(seg) && !namesNoCity(seg, us) : isRegion(seg) || !namesNoCity(seg, us)));
  if (city && l.remote !== 'remote') return city.toLowerCase();
  const country = us ? null : [...namedCountries(l.raw)].find((c) => c !== 'US');
  const key = (country || (!us && city) || 'remote').toLowerCase();
  if (l.remote !== 'hybrid') return key;
  return key === 'remote' ? 'hybrid' : `${key}:hybrid`;
}

// Folder name for one posting's report: {company}-{role}, plus the city when
// the user's policy keeps one row per city (anything but remote only), so two
// cities of one title never share a folder, queue row, or tracker row.
// ponytail: keyed on the policy passed in, so a run that lifts a remote only
// profile with a flag still builds city free slugs unless the caller passes
// its merged filters. Folders made before this keep their old name.
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
function reportSlug({ company, title, role, location } = {}, { remoteOnly = false } = {}) {
  const city = remoteOnly || !location ? '' : place({ location });
  // Names are folded the way stored posting text is, so a name read off the
  // page and the stored one give one slug. A name that loses letters in the
  // fold (another script) gets a short hash of the original, so the slug is
  // never empty and two such names never share a folder.
  // ponytail: a mixed script title stored by createPosting is already folded,
  // so its batch slug has no hash while the same title read off the page has.
  const part = (s) => {
    const raw = String(s || '').normalize('NFKC').trim();
    const lost = [...raw].some((ch) => /\p{L}/u.test(ch) && !textClean(ch));
    const hash = lost ? crypto.createHash('sha1').update(raw.toLowerCase()).digest('hex').slice(0, 8) : '';
    return [slugify(textClean(raw)), hash].filter(Boolean).join('-');
  };
  return [part(company), part(title || role), city === 'remote' ? '' : slugify(city)].filter(Boolean).join('-');
}

function dedup(postings, { jaccardThreshold = 0.70, byLocation = false } = {}) {
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

  // Pass 2: exact dedupKey (company-slug + role-normalized), plus the city
  // when byLocation is set
  const byKey = new Map();
  for (const p of urlDeduped) {
    const k = byLocation ? `${p.dedupKey}|${place(p)}` : p.dedupKey;
    const existing = byKey.get(k);
    byKey.set(k, existing ? mergePostings(existing, p) : p);
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
        if (keyDeduped[i].companySlug === keyDeduped[hit.id].companySlug
          && (!byLocation || place(keyDeduped[i]) === place(keyDeduped[hit.id]))) {
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

module.exports = { dedup, mergePostings, postingFuzzyText, place, reportSlug };
