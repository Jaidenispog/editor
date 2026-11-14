import type { WorkerContext } from '../../context.js';
import { httpRequest, readJson } from '../http.js';

/**
 * Google Places API (New), Place Details only (email design §8.2, memo §7 Tier 1). Read-only, with the smallest
 * field mask: rating, review count and Google's own review links (plus the name and address once, to confirm the
 * place). The key stays server-side and is never sent to the browser.
 */
export const PLACES_API_BASE = 'https://places.googleapis.com/v1';
export const PLACES_FIELDS_CONNECT = 'id,displayName,formattedAddress,googleMapsLinks,rating,userRatingCount';
export const PLACES_FIELDS_DAILY = 'googleMapsLinks,rating,userRatingCount';

/** What a Place Details call returned that the app keeps (only the latest snapshot, no history). */
export interface PlaceSnapshot {
  rating: number | null;
  userRatingCount: number | null;
  writeAReviewUri: string | null;
  readReviewsUri: string | null;
  displayName: string | null;
  formattedAddress: string | null;
}

/** A Places failure with a plain message; `transient` ones are retried the next day. */
export class PlacesError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PlacesError';
  }
}

/** Plain message for a Places error status (design §8.2). */
export function placesErrorFor(status: number, googleStatus: string | null): PlacesError {
  if (status === 400 || googleStatus === 'INVALID_ARGUMENT') return new PlacesError("That Place ID isn't valid.", false, status);
  if (status === 403 || googleStatus === 'PERMISSION_DENIED') return new PlacesError("The key isn't allowed to use Places API (New), or billing is off.", false, status);
  if (status === 404 || googleStatus === 'NOT_FOUND') return new PlacesError('Google no longer recognises this Place ID; look it up again.', false, status);
  if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') return new PlacesError('Google limited requests for now; the rating will refresh tomorrow.', true, status);
  return new PlacesError(`Google could not answer right now (HTTP ${status}).`, status >= 500, status);
}

/** Calls Place Details for one place with the given field mask. */
export async function fetchPlaceDetails(ctx: Pick<WorkerContext, 'fetch' | 'logger'>, apiKey: string, placeId: string, fieldMask: string, signal: AbortSignal): Promise<PlaceSnapshot> {
  const url = `${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}?languageCode=en-AU&regionCode=AU`;
  const res = await httpRequest(ctx, url, { method: 'GET', headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask, Accept: 'application/json' } }, { label: 'google.places.details', signal });
  const body = (await readJson(res)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = body?.['error'] as { status?: unknown } | undefined;
    throw placesErrorFor(res.status, typeof err?.status === 'string' ? err.status : null);
  }
  const links = (body?.['googleMapsLinks'] ?? {}) as Record<string, unknown>;
  const name = body?.['displayName'] as { text?: unknown } | undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    rating: typeof body?.['rating'] === 'number' ? (body['rating'] as number) : null,
    userRatingCount: typeof body?.['userRatingCount'] === 'number' ? (body['userRatingCount'] as number) : null,
    writeAReviewUri: str(links['writeAReviewUri']),
    readReviewsUri: str(links['readReviewsUri']),
    displayName: str(name?.text),
    formattedAddress: str(body?.['formattedAddress']),
  };
}
