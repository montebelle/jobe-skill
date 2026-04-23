/**
 * Tailoring-depth measurement.
 *
 * Industry claims for "tailored resumes +31% callback rate" (Resumly) and
 * the more rigorous Resume2Vec MDPI 2024 (+15.85% nDCG with embedding
 * retrieval) are the best empirical anchors we have, but both are below
 * peer-reviewed RCT quality. Rather than trust the prior, we measure:
 * every application records its tailoring depth; /jobe patterns then
 * correlates tailoring depth with response rate.
 *
 * Tailoring depth taxonomy:
 *   generic  - same resume as most recent baseline, no JD-specific edits
 *   light    - summary rewritten + 1-2 bullet reorderings for keyword match
 *   deep     - new summary + 3+ bullets rewritten + new cover letter + custom-question answers
 *
 * Usage:
 *   const { assessTailoring } = require('./lib/tailoring');
 *   const depth = assessTailoring(currentResumeJson, baselineResumeJson);
 *   // => { depth: 'deep', bulletDiffCount, summaryChanged, hasCoverLetter }
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');

const BASELINE_PATH = () => path.join(getProjectRoot(), 'data', 'resume-baseline.json');

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH())) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE_PATH(), 'utf8')); } catch { return null; }
}

function saveBaseline(resumeJson) {
  fs.mkdirSync(path.dirname(BASELINE_PATH()), { recursive: true });
  fs.writeFileSync(BASELINE_PATH(), JSON.stringify(resumeJson, null, 2));
}

function summaryChanged(a, b) {
  return (a?.summary || '').trim() !== (b?.summary || '').trim();
}

function bulletDiffCount(a, b) {
  if (!a?.experience || !b?.experience) return 0;
  let changed = 0;
  const key = (role) => role.company + '::' + role.title;
  const mapB = new Map();
  for (const r of b.experience) mapB.set(key(r), r.bullets || []);
  for (const roleA of a.experience) {
    const bB = mapB.get(key(roleA)) || [];
    const setB = new Set(bB.map(s => s.trim()));
    for (const bullet of roleA.bullets || []) {
      if (!setB.has(bullet.trim())) changed++;
    }
  }
  return changed;
}

function assessTailoring(current, baseline = loadBaseline()) {
  if (!baseline) return { depth: 'unknown', reason: 'no baseline saved' };
  const summaryDiff = summaryChanged(current, baseline);
  const bulletDiff = bulletDiffCount(current, baseline);
  const hasCoverLetter = !!(current?.coverLetter && current.coverLetter.length > 100);
  const hasWhyCompany = !!(current?.whyCompany && current.whyCompany.length > 40);

  let depth = 'generic';
  if (summaryDiff && bulletDiff >= 3) depth = 'deep';
  else if (summaryDiff || bulletDiff >= 1) depth = 'light';
  if (hasCoverLetter && hasWhyCompany && bulletDiff >= 3) depth = 'deep';

  return {
    depth,
    summaryChanged: summaryDiff,
    bulletDiffCount: bulletDiff,
    hasCoverLetter,
    hasWhyCompany,
  };
}

// Update apply-queue entry with tailoring depth when an application is recorded
function annotateQueueEntry(entry, currentResumeJson) {
  const assessment = assessTailoring(currentResumeJson);
  return {
    ...entry,
    tailoringDepth: assessment.depth,
    tailoringMeta: {
      summaryChanged: assessment.summaryChanged,
      bulletDiffCount: assessment.bulletDiffCount,
      hasCoverLetter: assessment.hasCoverLetter,
      hasWhyCompany: assessment.hasWhyCompany,
    },
  };
}

module.exports = { loadBaseline, saveBaseline, assessTailoring, annotateQueueEntry };
