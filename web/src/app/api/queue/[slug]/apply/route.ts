import { NextResponse } from 'next/server';
import {
  updateQueueEntry,
  updateTrackerStatus,
  moveReportFolder,
} from '@/lib/writer';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const today = new Date().toISOString().slice(0, 10);
    updateQueueEntry(slug, { applied: true, appliedDate: today });
    try { updateTrackerStatus({ slug, newStatus: 'Applied' }); } catch {}
    try { moveReportFolder(slug, 'applied'); } catch {}
    return NextResponse.json({ ok: true, slug, applied: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String((err as Error).message ?? err) },
      { status: 500 },
    );
  }
}
