import { NextResponse } from 'next/server';
import {
  updateQueueEntry,
  updateTrackerStatus,
  moveReportFolder,
} from '@/lib/writer';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  let reason = 'no reason';
  try {
    const body = (await req.json()) as { reason?: string };
    if (body?.reason) reason = body.reason;
  } catch {
    /* empty body OK */
  }

  try {
    updateQueueEntry(slug, { skipped: true, skipReason: reason });
    try { updateTrackerStatus({ slug, newStatus: 'Skipped' }); } catch {}
    try { moveReportFolder(slug, 'skipped'); } catch {}
    return NextResponse.json({ ok: true, slug, skipped: true, reason });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String((err as Error).message ?? err) },
      { status: 500 },
    );
  }
}
