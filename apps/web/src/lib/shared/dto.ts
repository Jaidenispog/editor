import type { JobType } from '@studio/core';

/**
 * Browser-facing data shapes (plain JSON, dates as ISO strings). Server code builds these; client
 * components consume them. Keep in sync with lib/projects.ts, lib/music.ts and lib/trends.ts.
 */
export interface ProjectSummaryDto {
  id: string;
  title: string;
  clientName: string;
  notes: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  assetCount: number;
  readyAssetCount: number;
  editCount: number;
  latestGeneration: { id: string; status: string; statusMessage: string; createdAt: string } | null;
}

/** A background job as shown in progress lists. */
export interface JobDto {
  id: string;
  type: string;
  projectId: string | null;
  projectTitle?: string | null;
  refId: string | null;
  status: string;
  progress: number;
  message: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Friendly names for every registered job type (Australian English). `satisfies` makes a job type without a label a
 * type error, and test/job-labels.test.ts checks the registry at run time, so the owner never sees a raw name.
 */
const JOB_LABELS = {
  'ingest.asset': 'Analysing clip',
  'edits.generate': 'Planning edits',
  'edits.revise': 'Revising edit',
  'render.preview': 'Rendering preview',
  'render.export': 'Exporting full quality',
  'music.analyse': 'Analysing music',
  'maintenance.cleanup': 'Cleaning up temporary files',
  'google.disconnect': 'Disconnecting Google',
  'webhook.process': 'Processing an update from a connected service',
  'preferences.recompute': 'Learning from your choices',
  'reference.analyse': 'Analysing a reference video',
  'trends.refresh': 'Refreshing trends',
  'publish.prepare': 'Preparing a post',
  'publish.target': 'Publishing a post',
  'publish.dispatch': 'Starting scheduled posts',
  'publish.poll': 'Checking a post’s status',
  'social.check': 'Checking a social connection (read-only)',
  'square.sync': 'Syncing with Square (read-only)',
  'square.refresh': 'Updating a booking or client from Square',
  'square.attendance': 'Matching Square payments to bookings',
  'square.availability': 'Finding free times in Square',
  'square.token_refresh': 'Renewing Square access',
  'square.revoke': 'Revoking Square access',
  'email.automation.sweep': 'Preparing automatic emails',
  'email.campaign.expand': 'Preparing campaign emails',
  'email.dispatch': 'Handing approved emails to Postmark',
  'email.send': 'Sending an approved email',
  'email.provider.check': 'Checking the email connection (read-only)',
  'email.suppression.push': 'Updating Postmark’s do-not-send list',
  'reviews.places.sync': 'Fetching your Google rating',
  'website.audit': 'Checking your website',
  'website.edit_apply': 'Applying a website change',
  'website.copy_draft': 'Writing wording suggestions',
  'website.connection_check': 'Checking a connection (read-only)',
  'search.sync': 'Fetching search data',
} as const satisfies Record<JobType, string>;

/** Friendly names for job types (looked up by the stored type string). */
export const JOB_TYPE_LABELS: Readonly<Record<string, string>> = JOB_LABELS;
