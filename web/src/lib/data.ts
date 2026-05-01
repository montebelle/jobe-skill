import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { paths, JOBE_ROOT } from './paths';
import type {
  QueueEntry,
  ResumeJSON,
  TrackerRow,
  DiscoveryPosting,
  DiscoverySummary,
  PipelineStage,
} from './types';

// ── Cheap JSON read with a graceful fallback ──────────────────────
function readJSON<T>(p: string, fallback: T): T {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
function readText(p: string, fallback = ''): string {
  try {
    if (!fs.existsSync(p)) return fallback;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return fallback;
  }
}

// ── Apply queue ──────────────────────────────────────────────────
export function getQueue(): QueueEntry[] {
  const raw = readJSON<QueueEntry[]>(paths.applyQueue, []);
  return raw.map(normalize);
}

function normalize(e: QueueEntry): QueueEntry {
  // Stale-path tolerance + path normalization (entries can be absolute or
  // repo-relative; serve API needs repo-relative for the docx route).
  const rel = (p?: string) =>
    p ? p.replace(JOBE_ROOT + '/', '').replace(/^\.\//, '') : p;
  return {
    ...e,
    resumeDocx: rel(e.resumeDocx) ?? '',
    coverLetterDocx: rel(e.coverLetterDocx),
    company: e.company || 'Unknown',
    role: e.role || '(untitled)',
  };
}

export function getQueuePending(): QueueEntry[] {
  return getQueue().filter((e) => !e.applied && !e.skipped);
}
export function getQueueApplied(): QueueEntry[] {
  return getQueue().filter((e) => e.applied);
}
export function getQueueSkipped(): QueueEntry[] {
  return getQueue().filter((e) => e.skipped);
}

// ── Reports ──────────────────────────────────────────────────────

/** Resolve a report folder for a slug; checks active, applied, skipped. */
export function findReportDir(slug: string): string | null {
  const candidates = [
    path.join(paths.reports, slug),
    path.join(paths.reports, 'applied', slug),
    path.join(paths.reports, 'skipped', slug),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return null;
}

export function loadResumeJSON(slug: string): ResumeJSON | null {
  const dir = findReportDir(slug);
  if (!dir) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('resume-') && f.endsWith('.json'))
    .sort()
    .reverse(); // newest first by date prefix
  if (!files.length) return null;
  return readJSON<ResumeJSON | null>(path.join(dir, files[0]), null);
}

export function listReportFiles(slug: string): {
  resumeDocx?: string;
  coverLetterDocx?: string;
  resumeJson?: string;
  analysisMd?: string;
} {
  const dir = findReportDir(slug);
  if (!dir) return {};
  const files = fs.readdirSync(dir);
  const find = (re: RegExp) => files.find((f) => re.test(f));
  const rel = (f?: string) =>
    f ? path.relative(JOBE_ROOT, path.join(dir, f)) : undefined;
  return {
    resumeDocx: rel(find(/^resume-.+\.docx$/)),
    coverLetterDocx: rel(find(/^cover-letter-.+\.docx$/)),
    resumeJson: rel(find(/^resume-.+\.json$/)),
    analysisMd: rel(find(/^analysis-.+\.md$/)),
  };
}

// ── Tracker ──────────────────────────────────────────────────────

/** Parse the tracker.md table into structured rows. */
export function getTracker(): TrackerRow[] {
  const md = readText(paths.tracker);
  const rows: TrackerRow[] = [];
  const lines = md.split('\n');
  let headerSeen = false;
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (/^\|[\s-]+\|/.test(line)) continue; // separator
    if (!headerSeen) {
      // First | line is the header
      if (/^\|\s*#\s*\|/.test(line)) {
        headerSeen = true;
      }
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    const [idx, date, company, role, score, status, resume, notes] = cells;
    const num = parseInt(idx, 10);
    if (Number.isNaN(num)) continue;
    rows.push({
      index: num,
      date: date,
      company,
      role,
      score: score && /^\d+$/.test(score) ? parseInt(score, 10) : undefined,
      status,
      reportDir: resume,
      notes,
    });
  }
  return rows;
}

// ── Discovery ────────────────────────────────────────────────────

/** Find the most-recent discovered/{date}/ directory containing the artifact. */
function latestDiscoveryDir(artifact = 'ranked-enriched.json'): string | null {
  if (!fs.existsSync(paths.signals)) return null;
  const dates = fs
    .readdirSync(paths.signals)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const candidate = path.join(paths.signals, dates[i], artifact);
    if (fs.existsSync(candidate)) return path.join(paths.signals, dates[i]);
  }
  return null;
}

export function getLatestDiscovery(): {
  date: string | null;
  enriched: DiscoveryPosting[];
  summary: DiscoverySummary | null;
} {
  const dir = latestDiscoveryDir('ranked-enriched.json');
  if (!dir) return { date: null, enriched: [], summary: null };
  const date = path.basename(dir);
  const enriched = readJSON<DiscoveryPosting[]>(
    path.join(dir, 'ranked-enriched.json'),
    [],
  );
  const summary = readJSON<DiscoverySummary | null>(
    path.join(dir, 'discovery-summary.json'),
    null,
  );
  return { date, enriched, summary };
}

// ── Company index ────────────────────────────────────────────────

export function getCompanyIndexSize(): number {
  const idx = readJSON<Record<string, unknown>>(paths.companyIndex, {});
  return Object.keys(idx).length;
}

// ── Pipeline stages (the funnel) ─────────────────────────────────

export function getPipelineStages(): PipelineStage[] {
  const queue = getQueue();
  const tracker = getTracker();
  const discovery = getLatestDiscovery();

  const discovered = discovery.summary?.afterFilter ?? discovery.enriched.length;
  const evaluated = queue.length;
  const queued = queue.filter((e) => !e.applied && !e.skipped).length;
  const applied = queue.filter((e) => e.applied).length;
  const responded = tracker.filter((r) =>
    /respond|interview|offer|screen/i.test(r.status),
  ).length;
  const interviewing = tracker.filter((r) =>
    /interview|onsite|loop/i.test(r.status),
  ).length;
  const offer = tracker.filter((r) => /offer/i.test(r.status)).length;

  const stages: PipelineStage[] = [
    { key: 'discovered',   label: 'Discovered',  count: discovered },
    { key: 'evaluated',    label: 'Evaluated',   count: evaluated },
    { key: 'queued',       label: 'Queued',      count: queued },
    { key: 'applied',      label: 'Applied',     count: applied },
    { key: 'responded',    label: 'Responded',   count: responded },
    { key: 'interviewing', label: 'Interviewing', count: interviewing },
    { key: 'offer',        label: 'Offer',       count: offer },
  ];

  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1].count;
    stages[i].conversionFromPrev = prev > 0 ? stages[i].count / prev : 0;
  }
  return stages;
}

// ── Stats ────────────────────────────────────────────────────────

export function getArchetypeBreakdown(): Array<{ archetype: string; count: number }> {
  const queue = getQueue();
  const counts = new Map<string, number>();
  for (const e of queue) {
    const a = (e.archetype || 'Unspecified').split('/')[0].trim();
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([archetype, count]) => ({ archetype, count }))
    .sort((a, b) => b.count - a.count);
}

export function getScoreHistogram(bucket = 5): Array<{ band: string; count: number }> {
  const queue = getQueue();
  const buckets = new Map<number, number>();
  for (const e of queue) {
    if (typeof e.score !== 'number') continue;
    const b = Math.floor(e.score / bucket) * bucket;
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, count]) => ({ band: `${b}-${b + bucket - 1}`, count }));
}

export function getApplicationsByDate(): Array<{ date: string; count: number }> {
  const tracker = getTracker();
  const counts = new Map<string, number>();
  for (const r of tracker) {
    if (!/applied/i.test(r.status)) continue;
    counts.set(r.date, (counts.get(r.date) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));
}

export function getSourceAttribution(): Array<{ source: string; count: number }> {
  const { enriched } = getLatestDiscovery();
  const counts = new Map<string, number>();
  for (const p of enriched) {
    const src = p.discoveredVia?.[0]?.source || 'unknown';
    counts.set(src, (counts.get(src) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Recent activity feed (for the home page) ─────────────────────
export interface ActivityItem {
  ts: string;
  kind: 'applied' | 'skipped' | 'queued';
  company: string;
  role: string;
  score?: number;
  slug?: string;
}
export function getRecentActivity(limit = 12): ActivityItem[] {
  const queue = getQueue();
  const items: ActivityItem[] = [];
  for (const e of queue) {
    if (e.applied && e.appliedDate) {
      items.push({
        ts: e.appliedDate,
        kind: 'applied',
        company: e.company,
        role: e.role,
        score: e.score,
        slug: e.slug,
      });
    } else if (e.skipped) {
      items.push({
        ts: e.appliedDate || '',
        kind: 'skipped',
        company: e.company,
        role: e.role,
        score: e.score,
        slug: e.slug,
      });
    }
  }
  return items
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, limit);
}
