import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { JOBE_ROOT } from '@/lib/paths';

/**
 * Serve a file from the parent jobe repo. Scoped to:
 *   - reports/**  (resume + cover-letter DOCX, analysis MD)
 *   - data/**     (tracker.md, story-bank.md, followups.md — read-only)
 *   - signals/**  (discovery JSONs)
 *
 * Rejects path traversal. Rejects everything else.
 */
const ALLOWED_PREFIXES = ['reports/', 'data/', 'signals/'];
const MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.json': 'application/json',
  '.md':   'text/markdown; charset=utf-8',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: parts } = await params;
  if (!parts || parts.length === 0) {
    return NextResponse.json({ error: 'no path' }, { status: 400 });
  }

  const rel = parts.join('/');
  if (rel.includes('..') || path.isAbsolute(rel)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const absolute = path.resolve(JOBE_ROOT, rel);
  if (!absolute.startsWith(JOBE_ROOT)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const ext = path.extname(absolute).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';
  const data = fs.readFileSync(absolute);
  const filename = path.basename(absolute);

  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition':
        ext === '.docx'
          ? `attachment; filename="${filename}"`
          : `inline; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
