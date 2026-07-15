/**
 * Session-start validator.
 * Checks data integrity before any mode runs.
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot, getSystemRoot } = require('./config');

function runSyncCheck() {
  const root = getProjectRoot();
  const warnings = [];
  let ok = true;

  // 1. Check reference.md exists and has content. The workspace-root copy
  // (where scripts/user.js scaffolds it) is authoritative; the ~/.claude paths
  // are the legacy single-user fallback.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const refPaths = [
    path.join(root, 'reference.md'),
    path.join(home, '.claude', 'skills', 'jobe', 'reference.md'),
    path.join(root, '..', '.claude', 'skills', 'jobe', 'reference.md')
  ];

  let refFound = false;
  for (const p of refPaths) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      if (content.split('\n').length < 50) {
        warnings.push(`reference.md exists but seems thin (${content.split('\n').length} lines)`);
      }
      refFound = true;
      break;
    }
  }
  if (!refFound) {
    warnings.push('reference.md not found. Portfolio evidence unavailable.');
    ok = false;
  }

  // 2. Check tracker exists
  const trackerPath = path.join(root, 'data', 'tracker.md');
  if (!fs.existsSync(trackerPath)) {
    warnings.push('data/tracker.md not found. Creating empty tracker.');
    const dir = path.dirname(trackerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(trackerPath, '# Application Tracker\n\n| # | Date | Company | Role | Score | Status | Resume | Notes |\n|---|------|---------|------|-------|--------|--------|-------|\n');
  }

  // 3. Check story-bank freshness
  const storyPath = path.join(root, 'data', 'story-bank.md');
  if (fs.existsSync(storyPath)) {
    const stat = fs.statSync(storyPath);
    const daysSinceModified = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    if (daysSinceModified > 30) {
      warnings.push(`story-bank.md last updated ${Math.round(daysSinceModified)} days ago. Consider refreshing.`);
    }
  } else {
    warnings.push('data/story-bank.md not found. Interview prep will be limited.');
  }

  // 4. Check configs (SHARED system layer — validate the install-root copy)
  const configPath = path.join(getSystemRoot(), 'configs', 'default.json');
  if (fs.existsSync(configPath)) {
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      warnings.push('configs/default.json is not valid JSON.');
      ok = false;
    }
  }

  return { ok, warnings };
}

// CLI mode
if (require.main === module) {
  const result = runSyncCheck();
  if (result.warnings.length > 0) {
    console.log('Sync check warnings:');
    for (const w of result.warnings) console.log(`  - ${w}`);
  }
  console.log(`Status: ${result.ok ? 'OK' : 'ISSUES FOUND'}`);
}

module.exports = { runSyncCheck };
