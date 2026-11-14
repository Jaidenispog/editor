'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/client/api-client';
import type { StudioStatusDto } from '@/lib/shared/studio-dto';

/** Poll every 3 s while something is queued or working, every 20 s otherwise. */
export const BUSY_POLL_MS = 3000;
export const IDLE_POLL_MS = 20_000;

/**
 * Keeps the Video Studio status fresh: polls GET /api/projects/[id]/status (fast while busy, slow when idle),
 * stops while the tab is hidden and refreshes as soon as it is visible again. `refresh()` fetches now (call it
 * after any change) and re-plans the next poll.
 */
export function useStudioStatus(projectId: string, initial: StudioStatusDto) {
  const [status, setStatus] = useState<StudioStatusDto>(initial);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(initial.busy);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!mountedRef.current || document.visibilityState !== 'visible') return;
    timerRef.current = setTimeout(() => void fetchNowRef.current(), busyRef.current ? BUSY_POLL_MS : IDLE_POLL_MS);
  }, []);

  const fetchNow = useCallback(async () => {
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    try {
      const next = await apiRequest<StudioStatusDto>(`/api/projects/${projectId}/status`, { signal: controller.signal });
      if (!mountedRef.current) return;
      busyRef.current = next.busy;
      setStatus(next);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'The latest progress could not be loaded.');
    } finally {
      if (inFlightRef.current === controller) inFlightRef.current = null;
      schedule();
    }
  }, [projectId, schedule]);

  const fetchNowRef = useRef(fetchNow);
  useEffect(() => {
    fetchNowRef.current = fetchNow;
  }, [fetchNow]);

  useEffect(() => {
    mountedRef.current = true;
    schedule();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchNowRef.current();
      else if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (timerRef.current) clearTimeout(timerRef.current);
      inFlightRef.current?.abort();
    };
  }, [schedule]);

  /** Marks the page busy (fast polling) straight after starting work, then fetches. */
  const refresh = useCallback(
    (options: { expectBusy?: boolean } = {}) => {
      if (options.expectBusy) busyRef.current = true;
      return fetchNow();
    },
    [fetchNow],
  );

  return { status, setStatus, error, refresh };
}

/**
 * Keeps a signed media link stable across polls so a playing video or a thumbnail is not reloaded every few
 * seconds. A newer link is adopted only after half of the link lifetime has passed, or when `renew()` is
 * called (for example after the player reports an error because the old link expired).
 */
export function useStableLink(id: string | null, url: string | null, ttlSeconds: number): { url: string | null; renew: () => void } {
  const ref = useRef<{ id: string | null; url: string | null; at: number }>({ id: null, url: null, at: 0 });
  const [, force] = useState(0);
  const now = Date.now();
  const current = ref.current;
  const stale = now - current.at > (ttlSeconds * 1000) / 2;
  if (current.id !== id || !current.url || (url && stale)) {
    ref.current = { id, url, at: now };
  }
  const renew = useCallback(() => {
    if (url && url !== ref.current.url) {
      ref.current = { id, url, at: Date.now() };
      force((n) => n + 1);
    }
  }, [id, url]);
  return { url: ref.current.url, renew };
}
