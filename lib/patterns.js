/**
 * Application history pattern analysis.
 * Mines tracker data for conversion insights.
 */

const path = require('path');
const { getProjectRoot } = require('./config');
const { parseTracker, STATUSES } = require('./tracker');
const { ARCHETYPES } = require('./archetypes');

// Bucket names come from the user's own taxonomy (lib/archetypes.js); none are
// built in. A name written "Head / Tail" is also recognized by its head alone,
// since notes often carry the short form. No taxonomy: no archetype analysis.
function archetypeMatchers(taxonomy = ARCHETYPES) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return Object.keys(taxonomy).map((name) => {
    const forms = [...new Set([name, name.split('/')[0]].map((f) => f.trim()).filter(Boolean))];
    return { name, re: new RegExp(`(?<![a-z0-9])(?:${forms.map(esc).join('|')})(?![a-z0-9])`, 'i') };
  });
}

const STATUS_ORDER = ['Discovered', 'Evaluated', 'Applied', 'Responded', 'Interviewing', 'Offer', 'Rejected', 'Skipped'];

function analyzePatterns(trackerPath) {
  // Use the parseTracker from tracker.js (single source of truth)
  const entries = parseTracker();

  if (entries.length < 5) {
    return { insufficient: true, total: entries.length, message: 'Need at least 5 tracked applications for meaningful analysis.' };
  }

  // Conversion funnel
  const statusCounts = {};
  for (const s of STATUS_ORDER) statusCounts[s] = 0;
  for (const e of entries) {
    if (statusCounts[e.status] !== undefined) statusCounts[e.status]++;
  }

  const conversionRates = {};
  for (let i = 0; i < STATUS_ORDER.length - 1; i++) {
    const from = STATUS_ORDER[i];
    const to = STATUS_ORDER[i + 1];
    if (statusCounts[from] > 0 && statusCounts[to] !== undefined) {
      conversionRates[`${from}->${to}`] = Math.round((statusCounts[to] / statusCounts[from]) * 100);
    }
  }

  // Score distribution
  const appliedScores = entries.filter(e => ['Applied', 'Responded', 'Interviewing', 'Offer'].includes(e.status)).map(e => parseFloat(e.score) || 0).filter(s => s > 0);
  const skippedScores = entries.filter(e => ['Skipped', 'Rejected'].includes(e.status)).map(e => parseFloat(e.score) || 0).filter(s => s > 0);

  const avgApplied = appliedScores.length > 0 ? Math.round(appliedScores.reduce((a, b) => a + b, 0) / appliedScores.length) : 0;
  const avgSkipped = skippedScores.length > 0 ? Math.round(skippedScores.reduce((a, b) => a + b, 0) / skippedScores.length) : 0;

  // Archetype analysis (from notes field)
  const archetypeCounts = {};
  const archetypeSuccess = {};
  const matchers = archetypeMatchers();
  for (const e of entries) {
    const hit = matchers.find((m) => m.re.test(e.notes || ''));
    if (hit) {
      const arch = hit.name;
      archetypeCounts[arch] = (archetypeCounts[arch] || 0) + 1;
      if (['Responded', 'Interviewing', 'Offer'].includes(e.status)) {
        archetypeSuccess[arch] = (archetypeSuccess[arch] || 0) + 1;
      }
    }
  }

  return {
    insufficient: false,
    total: entries.length,
    statusCounts,
    conversionRates,
    scoreDistribution: { avgApplied, avgSkipped, threshold: Math.max(avgApplied - 10, 55) },
    archetypePerformance: { counts: archetypeCounts, successes: archetypeSuccess }
  };
}

// CLI mode
if (require.main === module) {
  const result = analyzePatterns();
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { analyzePatterns, archetypeMatchers };
