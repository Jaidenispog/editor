/** Durability settings for one job type. */
export interface QueueSetting {
  /** Retries after the first attempt. */
  retryLimit: number;
  /** Seconds before the first retry. */
  retryDelay: number;
  /** Double the delay on each further retry. */
  retryBackoff: boolean;
  /** Hard ceiling for one attempt, in seconds (a stuck attempt is failed and retried). */
  expireInSeconds: number;
  /** Seconds without a heartbeat before pg-boss fails an attempt (at least 10). */
  heartbeatSeconds: number;
  /**
   * pg-boss queue policy. `standard` (the default) allows any number of queued jobs; `stately` allows one queued
   * and one active job per `singletonKey`. Fixed when the queue is first created; pg-boss cannot change it later.
   */
  policy?: 'standard' | 'stately';
}

/** A module's queue settings, keyed by job type. Every registered job type needs exactly one entry. */
export type QueueSettingsMap = Record<string, QueueSetting>;
