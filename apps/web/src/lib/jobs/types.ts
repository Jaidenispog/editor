/**
 * Returns the entity a job is about (so its progress lands on the right card), null when it is about nothing in
 * particular, or undefined when the job type belongs to another module.
 */
export type RefIdResolver = (type: string, payload: Record<string, unknown>) => string | null | undefined;
