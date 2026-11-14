/** Which way a clip moves in the project's order. */
export type MoveDirection = 'up' | 'down';

/** Moves one id a step up or down in a list; returns an unchanged copy at either end or for an unknown id. */
export function moveInOrder(ids: readonly string[], id: string, direction: MoveDirection): string[] {
  const from = ids.indexOf(id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
