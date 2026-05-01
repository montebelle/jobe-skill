/**
 * Shared types — these mirror the on-disk schemas the jobe CLI maintains.
 * The web layer is read-mostly; mutation endpoints route through the canonical
 * lib/tracker-writer.js so the contracts stay in sync.
 */

export type TailoringDepth =
  | 'none'
  | 'generic'
  | 'light'
  | 'deep'
  | 'pending-cover-letter';

export interface QueueEntry {
  slug: string;
  company: string;
  role: string;
  archetype?: string;
  score?: number;
  primaryUrl: string;
  alternativeUrls?: string[];
  resumeDocx: string;
  coverLetterDocx?: string;
  applied?: boolean;
  appliedDate?: string;
  skipped?: boolean;
  skipReason?: string;
  responseStatus?: string;
  followUpDue?: string;
  tailoringDepth?: TailoringDepth;
}

export interface ResumeJSON {
  name: string;
  company: string;
  role: string;
  date: string;
  contact: {
    phone?: string;
    email?: string;
    location?: string;
    linkedin?: string;
    github?: string;
  };
  summary: string;
  experience: Array<{
    title: string;
    company: string;
    location?: string;
    dates: string;
    subtitle?: string;
    bullets: string[];
  }>;
  selectedProjects?: Array<{ name: string; summary: string }>;
  education?: Array<{
    degree: string;
    school: string;
    location?: string;
    dates?: string;
  }>;
  skills?: Record<string, string>;
  coverLetter?: string;
  archetype?: string;
  matchScore?: number;
  postingUrl?: string;
}

export interface TrackerRow {
  index: number;
  date: string;
  company: string;
  role: string;
  score?: number;
  status: string;
  reportDir?: string;
  notes?: string;
}

export interface DiscoveryPosting {
  canonicalUrl: string;
  company: string;
  title: string;
  location?: string;
  remote?: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  us?: boolean | null;
  postedDate?: string | null;
  matchScore?: number | null;
  quickScore?: number | null;
  archetype?: string;
  ghost?: { score: number; label: string };
  discoveredVia?: Array<{ source: string }>;
  jdText?: string;
}

export interface DiscoverySummary {
  date: string;
  perSource: Record<string, number>;
  totalRaw: number;
  afterDedup: number;
  afterFilter: number;
  enriched: number;
  rejected: Record<string, number>;
  needsAgentFallback: boolean;
  fallbackReason: string | null;
}

export interface PipelineStage {
  key: string;
  label: string;
  count: number;
  conversionFromPrev?: number; // 0..1
}
