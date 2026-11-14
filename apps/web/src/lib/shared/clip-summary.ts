import type { AssetDto } from './studio-dto.js';
import { clipTagName } from './studio-schemas.js';

/** "3 shots: Before ×2, Result" (unknown and other shots are counted but not named), or null before analysis. */
export function shotSummary(asset: Pick<AssetDto, 'shots'>): string | null {
  if (!asset.shots) return null;
  const { count, labels } = asset.shots;
  const named = Object.entries(labels)
    .filter(([label]) => label !== 'unknown' && label !== 'other')
    .map(([label, n]) => `${clipTagName(label)}${n > 1 ? ` ×${n}` : ''}`);
  const base = `${count} shot${count === 1 ? '' : 's'}`;
  return named.length ? `${base}: ${named.join(', ')}` : base;
}

/**
 * The one status line under a clip's name. A ready clip shows only its shot summary: the worker's message for it
 * ("3 shots · HDR converted") repeats the summary and the HDR badge. Waiting, analysing and failed clips show the
 * worker's message, which says what is happening or what went wrong.
 */
export function clipStatusLine(asset: Pick<AssetDto, 'status' | 'statusMessage' | 'shots'>): string {
  const summary = shotSummary(asset);
  if (asset.status === 'ready') return summary ?? asset.statusMessage;
  return asset.statusMessage || summary || '';
}
