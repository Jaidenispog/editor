/** Sections of the app an integration belongs to (used to filter status cards per page). */
export type IntegrationArea = 'video' | 'publishing' | 'appointments' | 'email' | 'reviews' | 'website' | 'storage';

/** One integration as shown in Settings → Integrations and on each section page. Never contains secrets. */
export interface IntegrationStatus {
  id: string;
  name: string;
  areas: IntegrationArea[];
  /** The server has the credentials it needs (environment variables are present). */
  configured: boolean;
  /** An account is connected (or, for key-only services, the key is present and the feature is active). */
  connected: boolean;
  /** Plain-language explanation of the current state and what the owner needs to do next. */
  message: string;
  /** Names (never values) of environment variables still missing. */
  missingEnv: string[];
  /** Optional detail such as the model in use or the connected account name. */
  detail?: string;
}
