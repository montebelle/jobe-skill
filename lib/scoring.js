/**
 * Match scoring engine for positioning John's portfolio against job requirements.
 *
 * Used by collectors and render scripts. The SKILL.md orchestrator performs
 * the actual scoring inline (Claude does the matching), but these utilities
 * are available for structured JSON processing in render scripts.
 */

const CATEGORY_WEIGHTS = {
  requiredSkills: 3,
  preferredSkills: 1,
  techStack: 2,
  domainKnowledge: 2,
  experienceLevel: 2,
  education: 1,
  softCultural: 0.5
};

const MATCH_SCORES = {
  exact: 1.0,
  strong_adjacency: 0.7,
  weak_adjacency: 0.4,
  gap: 0.0
};

const THRESHOLDS = {
  strong: 85,
  good: 70,
  stretch: 55,
  reach: 0
};

function classifyOverallMatch(score) {
  if (score >= THRESHOLDS.strong) return 'Strong Match';
  if (score >= THRESHOLDS.good) return 'Good Match';
  if (score >= THRESHOLDS.stretch) return 'Stretch Match';
  return 'Reach';
}

function computeOverallScore(categoryScores) {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [category, data] of Object.entries(categoryScores)) {
    const weight = data.weight || CATEGORY_WEIGHTS[category] || 1;
    const score = data.score || 0;
    weightedSum += weight * score;
    totalWeight += weight;
  }

  // Category `score` values are 0..1 (MATCH_SCORES), so the weighted mean is
  // also 0..1. classifyOverallMatch() and THRESHOLDS are on a 0..100 scale, so
  // scale up before rounding. (The previous code rounded the 0..1 mean directly,
  // collapsing every result to 0 or 1 -> always "Reach".)
  return totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0;
}

function identifyGaps(requirementMappings) {
  return requirementMappings.filter(r =>
    r.match === 'gap' || r.match === 'weak_adjacency'
  );
}

function identifyDifferentiators(requirementMappings) {
  return requirementMappings.filter(r =>
    r.match === 'exact' && r.differentiator
  );
}

module.exports = {
  CATEGORY_WEIGHTS,
  MATCH_SCORES,
  THRESHOLDS,
  classifyOverallMatch,
  computeOverallScore,
  identifyGaps,
  identifyDifferentiators
};
