/**
 * Reciprocal Rank Fusion for hybrid retrieval and multi-signal ranking.
 *
 * Empirical backing: Bruch et al, "An Analysis of Fusion Functions for
 * Hybrid Retrieval" (ACM TOIS 2024). On BEIR and MS MARCO benchmarks, RRF
 * with k=60 beats dense-only by +1.4% nDCG@10 and BM25-only by +18%,
 * and is robust across corpora in ways linear weighting is not.
 *
 * Usage:
 *   const fused = rrf([
 *     { ranking: rankedByBm25,    k: 60 },
 *     { ranking: rankedByVector,  k: 60 },
 *   ], item => item.id);
 *
 * Each ranking is an ordered array (best first). Items need a stable id
 * function; score = sum over lists of 1 / (k + rank_in_list).
 */

const DEFAULT_K = 60;

function rrf(rankedLists, idFn = x => x, { k = DEFAULT_K } = {}) {
  const scores = new Map();
  const items = new Map();

  for (const list of rankedLists) {
    const ranking = Array.isArray(list) ? list : list.ranking;
    const listK = (list && typeof list === 'object' && !Array.isArray(list) && list.k) || k;
    for (let rank = 0; rank < ranking.length; rank++) {
      const item = ranking[rank];
      const id = idFn(item);
      const contrib = 1 / (listK + rank + 1); // ranks are 1-indexed
      scores.set(id, (scores.get(id) || 0) + contrib);
      if (!items.has(id)) items.set(id, item);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ item: items.get(id), score, id }));
}

// Signal-fusion helper: combine multiple scored-weight pairs using RRF
// on the rankings implied by each score. Used by lib/rank.js to combine
// title match, JD match, seniority, freshness into one ranking.
function fuseScores(postings, scorers, { k = DEFAULT_K } = {}) {
  const rankings = scorers.map(scoreFn => {
    return [...postings].sort((a, b) => scoreFn(b) - scoreFn(a));
  });
  return rrf(rankings, p => p.canonicalUrl, { k }).map(({ item, score }) => ({ posting: item, rrfScore: score }));
}

module.exports = { rrf, fuseScores, DEFAULT_K };
