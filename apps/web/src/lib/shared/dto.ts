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

/** Friendly names for job types. */
export const JOB_TYPE_LABELS: Record<string, string> = {
  'ingest.asset': 'Analysing clip',
  'edits.generate': 'Planning edits',
  'edits.revise': 'Revising edit',
  'render.preview': 'Rendering preview',
  'render.export': 'Exporting full quality',
  'music.analyse': 'Analysing music',
  'maintenance.cleanup': 'Cleaning up temporary files',
};
