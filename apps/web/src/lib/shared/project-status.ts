/**
 * Words for a Video Studio project's status, shared by the project list, the dashboard's recent projects and the
 * project page header, so the same project always reads the same. "Ready" alone is never used: a project with
 * analysed clips and no edits is "Ready to generate".
 */
export const PROJECT_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'No clips yet',
  analysing: 'Analysing clips',
  ready: 'Ready to generate',
  generating: 'Making edits',
  complete: 'Edits ready',
  archived: 'Archived',
};

/** The status word (for the pill's colour) and label of a project. */
export interface ProjectStatusPill {
  status: string;
  label: string;
}

/**
 * The pill for a project: its own status, except that a latest generation that failed outright or only partly
 * worked is shown as such (the project status alone would read "Ready to generate" or "Edits ready").
 */
export function projectStatusPill(projectStatus: string, latestGenerationStatus?: string | null): ProjectStatusPill {
  if (projectStatus !== 'generating' && projectStatus !== 'archived') {
    if (latestGenerationStatus === 'failed') return { status: 'failed', label: 'Edits failed' };
    if (latestGenerationStatus === 'partial') return { status: 'partial', label: 'Some edits ready' };
  }
  const label = Object.prototype.hasOwnProperty.call(PROJECT_STATUS_LABELS, projectStatus) ? PROJECT_STATUS_LABELS[projectStatus] : undefined;
  return { status: projectStatus, label: label ?? capitalise(projectStatus) };
}

function capitalise(status: string): string {
  const words = status.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
