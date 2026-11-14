import type { MusicLicence, MusicLicenceKind } from '@studio/core';

/**
 * Licence kinds bought from a library or seller (a subscription or a single-track licence). Only their passport
 * records a plan, an account holder and a licence end date.
 */
export const LIBRARY_LICENCE_KINDS: ReadonlySet<MusicLicenceKind> = new Set<MusicLicenceKind>(['catalogue', 'commercial_licence']);

/**
 * Whether a track card shows the "Licence ends" line: for kinds that can have an end date, or whenever one is set.
 * An owner's own recording or a CC0 track has no end date to record, so "no end date recorded" would mislead.
 */
export function showsLicenceEnd(licence: Pick<MusicLicence, 'kind' | 'expiresAt'>): boolean {
  return Boolean(licence.expiresAt) || LIBRARY_LICENCE_KINDS.has(licence.kind);
}

/**
 * The status message a library track keeps when its beat analysis was cancelled (set by the web app's cancel and by
 * the worker's `music.analyse` handler). The track stays "uploaded", but nothing is running or queued for it.
 */
export const MUSIC_ANALYSIS_CANCELLED_MESSAGE = 'Analysis cancelled';

/** Whether a library track's analysis was cancelled: it is not ready and no work is queued or running for it. */
export function isAnalysisCancelled(track: { status: string; statusMessage: string | null | undefined }): boolean {
  return track.status === 'uploaded' && (track.statusMessage ?? '').trim().startsWith(MUSIC_ANALYSIS_CANCELLED_MESSAGE);
}

/** Whether analysis of a library track is really queued or running (the "once this finishes" line). */
export function isTrackAnalysing(track: { status: string; statusMessage: string | null | undefined }): boolean {
  return (track.status === 'uploaded' || track.status === 'processing') && !isAnalysisCancelled(track);
}

/**
 * The pill of a library track. A track that is uploaded or being analysed reads "Analysing" with the busy colour
 * (it cannot be used until the beat analysis finishes); "Uploaded" alone suggests it is done. A cancelled analysis
 * is not busy: it reads "Analysis stopped".
 */
export function trackStatusPill(status: 'uploaded' | 'processing' | 'ready' | 'failed', statusMessage?: string | null): { status: string; label: string } {
  if (isAnalysisCancelled({ status, statusMessage })) return { status: 'cancelled', label: 'Analysis stopped' };
  switch (status) {
    case 'uploaded':
    case 'processing':
      return { status: 'analysing', label: 'Analysing' };
    case 'ready':
      return { status: 'ready', label: 'Ready' };
    default:
      return { status: 'failed', label: 'Needs attention' };
  }
}

/**
 * Keys of finished audio uploads whose track is now in the library list: the track row says everything the upload
 * row did, so the upload row is dismissed instead of showing the same track twice.
 */
export function finishedUploadsShownAsTracks(uploads: ReadonlyArray<{ key: string; kind: string; state: string; resultId: string | null }>, trackIds: ReadonlyArray<string>): string[] {
  const ids = new Set(trackIds);
  return uploads.filter((u) => u.kind === 'audio' && u.state === 'done' && u.resultId !== null && ids.has(u.resultId)).map((u) => u.key);
}
