/**
 * Application tracker — persistent markdown table for pipeline management.
 * Tracks every job: discovered → evaluated → applied → interviewing → offer/rejected.
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');

const STATUSES = ['Discovered', 'Evaluated', 'Applied', 'Responded', 'Interviewing', 'Offer', 'Rejected', 'Skipped'];

function trackerPath() {
  return path.join(getProjectRoot(), 'data', 'tracker.md');
}

function ensureTracker() {
  const p = trackerPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '# Application Tracker\n\n| # | Date | Company | Role | Score | Status | Resume | Notes |\n|---|------|---------|------|-------|--------|--------|-------|\n');
  }
  return p;
}

function parseTracker() {
  const p = ensureTracker();
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const entries = [];

  for (const line of lines) {
    const match = line.match(/^\|\s*(\d+)\s*\|/);
    if (!match) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 7) {
      entries.push({
        num: parseInt(cells[0]),
        date: cells[1],
        company: cells[2],
        role: cells[3],
        score: cells[4],
        status: cells[5],
        resume: cells[6],
        notes: cells[7] || ''
      });
    }
  }
  return entries;
}

function nextNum() {
  const entries = parseTracker();
  return entries.length > 0 ? Math.max(...entries.map(e => e.num)) + 1 : 1;
}

function addEntry({ date, company, role, score, status, resume, notes }) {
  const p = ensureTracker();
  const num = nextNum();
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const statusStr = STATUSES.includes(status) ? status : 'Discovered';
  const line = `| ${num} | ${dateStr} | ${company} | ${role} | ${score || '-'} | ${statusStr} | ${resume || '-'} | ${notes || ''} |`;
  fs.appendFileSync(p, line + '\n');
  console.log(`Tracker: added #${num} — ${company} / ${role} [${statusStr}]`);
  return num;
}

function updateStatus(num, newStatus, notes) {
  const p = ensureTracker();
  let content = fs.readFileSync(p, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(new RegExp(`^\\|\\s*${num}\\s*\\|`));
    if (match) {
      const cells = lines[i].split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 7) {
        cells[5] = STATUSES.includes(newStatus) ? newStatus : cells[5];
        if (notes) cells[7] = notes;
        lines[i] = '| ' + cells.join(' | ') + ' |';
      }
      break;
    }
  }

  fs.writeFileSync(p, lines.join('\n'));
  console.log(`Tracker: updated #${num} → ${newStatus}`);
}

function getStats() {
  const entries = parseTracker();
  const stats = {};
  for (const s of STATUSES) stats[s] = 0;
  for (const e of entries) {
    if (stats[e.status] !== undefined) stats[e.status]++;
  }
  stats.total = entries.length;
  return stats;
}

function isDuplicate(company, role) {
  const entries = parseTracker();
  const compLower = company.toLowerCase();
  const roleLower = role.toLowerCase();
  return entries.some(e =>
    e.company.toLowerCase() === compLower && e.role.toLowerCase() === roleLower
  );
}

module.exports = { STATUSES, addEntry, updateStatus, parseTracker, getStats, isDuplicate, ensureTracker, trackerPath };
