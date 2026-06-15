/**
 * Multi-signal ghost-job scoring.
 *
 * Empirical backing:
 *   - Clarify Capital 2024 (n=1,200): 1-in-3 postings >30 days old,
 *     1-in-5 employers intentionally leave roles unfilled.
 *   - Revelio Labs 2024: hires-per-posting ratio fell 0.75 (2018) to
 *     <0.5 (2023). Low ratio is a company-level ghost-risk signal.
 *   - Hunter Ng (arXiv 2410.21771, 2024): posting age + reposting cadence
 *     are the two most predictive individual signals.
 *
 * Signals (each in [0,1], 0 = strong evidence real, 1 = strong evidence ghost):
 *   1. ageSignal          - posting age vs seniority-adjusted threshold
 *   2. repostSignal       - how many runs the same req has reappeared in
 *                           (cross-run via posting.reqRuns, set by the pipeline
 *                           from signals/req-history.json; falls back to the
 *                           same-run company history when reqRuns is absent)
 *   3. companyRatioSignal - company's hires-per-posting ratio vs baseline
 *   4. layoffSignal       - company recently announced layoffs
 *   5. titleFuzzSignal    - generic "always hiring" titles (Software Engineer
 *                           with no level, "Join our talent network")
 *
 * Data availability note: ageSignal and titleFuzzSignal run on every posting.
 * repostSignal activates once a req has been seen across multiple runs.
 * companyRatioSignal and layoffSignal require operator/tracker-supplied stats
 * (hiresPerPosting, recentLayoff) and stay at 0 until those are populated, so
 * on a cold index the effective detector is age + repost + titleFuzz.
 *
 * Final score is the max of these, not a sum: any one strong signal is
 * enough to flag. Final label:
 *   < 0.30 : High Confidence (show)
 *   0.30 - 0.60 : Proceed with Caution (show, flag)
 *   >= 0.60 : Suspicious (hide by default, accessible via --show-ghosts)
 */

function ageSignal(posting, { seniorityExtensionDays = 15 } = {}) {
  // Undated postings are mildly suspect, not assumed fresh. Kept below the
  // 0.30 caution threshold so it never hides a role on its own, but it nudges
  // the score and pairs with the post-enrich recency gate that drops undated
  // roles once enrichment reveals a real (old) date.
  if (!posting.postedDate) return 0.1;
  const ageDays = (Date.now() - new Date(posting.postedDate)) / 86400000;
  const seniorTitle = /\b(senior|staff|principal|lead|member of technical staff)\b/i.test(posting.title);
  const threshold = 30 + (seniorTitle ? seniorityExtensionDays : 0);
  if (ageDays <= threshold) return 0.0;
  if (ageDays <= threshold * 2) return 0.4 + 0.4 * ((ageDays - threshold) / threshold); // linear 0.4 -> 0.8
  return 0.9;
}

function repostSignal(posting, history) {
  // Preferred path: cross-run reappearance count, supplied by the pipeline from
  // signals/req-history.json. A req that has been re-listed across many runs is
  // the strongest individual ghost signal (Hunter Ng 2024).
  if (typeof posting.reqRuns === 'number') {
    const runs = posting.reqRuns;
    if (runs <= 1) return 0.0;
    if (runs === 2) return 0.3;
    if (runs === 3) return 0.55;
    return 0.8;
  }
  // Fallback: same-run duplicate titles for the company (rarely fires, since
  // dedup collapses exact duplicates upstream).
  if (!history || !history.length) return 0.0;
  const normTitle = posting.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).sort().join(' ');
  let reposts = 0;
  for (const h of history) {
    const ht = (h.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).sort().join(' ');
    if (ht === normTitle) reposts++;
  }
  if (reposts <= 1) return 0.0;
  if (reposts === 2) return 0.3;
  if (reposts === 3) return 0.55;
  return 0.8;
}

function companyRatioSignal(companyStats) {
  // companyStats.hiresPerPosting here is derived from JOHN'S tracker (his
  // responses / his applications at that company), NOT a company-wide hire
  // rate. On a handful of applications it is far too noisy to gate on -- a few
  // low-conversion high-volume employers (e.g. Amazon) would otherwise flag
  // hundreds of perfectly real postings as ghosts. So the contribution is
  // CAPPED at 0.5: it can raise "Proceed with Caution" but can never, on its
  // own, hide a posting (which needs >= 0.60). It only meaningfully fires once
  // tracker-stats has a large enough sample (applications >= 8).
  if (!companyStats || typeof companyStats.hiresPerPosting !== 'number') return 0.0;
  const ratio = companyStats.hiresPerPosting;
  if (ratio >= 0.5) return 0.0;
  if (ratio >= 0.35) return 0.2;
  if (ratio >= 0.20) return 0.35;
  return 0.5;
}

function layoffSignal(companyStats) {
  if (!companyStats || !companyStats.recentLayoff) return 0.0;
  const daysSinceLayoff = companyStats.recentLayoff.daysSince;
  if (typeof daysSinceLayoff !== 'number') return 0.5;
  if (daysSinceLayoff <= 30) return 0.7;
  if (daysSinceLayoff <= 90) return 0.5;
  if (daysSinceLayoff <= 180) return 0.3;
  return 0.1;
}

function titleFuzzSignal(posting) {
  const t = posting.title;
  if (/\b(talent\s*(network|community|pool))\b/i.test(t)) return 0.8;
  if (/\b(general|future|upcoming)\s+(application|role|position)s?\b/i.test(t)) return 0.7;
  if (/\bexpression\s*of\s*interest\b/i.test(t)) return 0.7;
  // Generic title with no level indicator and no specialization
  if (/^(software|machine\s*learning|data|ai)\s+engineer$/i.test(t.trim())) return 0.15;
  return 0.0;
}

function ghostScore(posting, { history = [], companyStats = {} } = {}) {
  const signals = {
    age: ageSignal(posting),
    repost: repostSignal(posting, history),
    companyRatio: companyRatioSignal(companyStats),
    layoff: layoffSignal(companyStats),
    titleFuzz: titleFuzzSignal(posting),
  };
  const score = Math.max(...Object.values(signals));
  let label = 'High Confidence';
  if (score >= 0.60) label = 'Suspicious';
  else if (score >= 0.30) label = 'Proceed with Caution';
  return { score, label, signals };
}

module.exports = {
  ghostScore,
  ageSignal, repostSignal, companyRatioSignal, layoffSignal, titleFuzzSignal,
};
