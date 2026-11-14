import 'server-only';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Project } from '@studio/db';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { ACTIVE_JOB_STATUSES, toJobDto } from './jobs.js';
import { maybeSignedUrl } from './media-links.js';
import { getSettings } from './settings.js';
import { UPLOAD_PART_SIZE } from './shared/upload-math.js';
import type { StudioStatusDto } from './shared/studio-dto.js';
import { shapeStudioStatus, type LinkSigner } from './studio-status-shape.js';
import { getWorkerStatus } from './worker-status.js';

/** How many generations the status payload carries (newest first). */
const GENERATION_LIMIT = 20;

/**
 * Loads everything the Video Studio page shows for one project and shapes it for the browser
 * (GET /api/projects/[id]/status and the first server render). Media links are freshly signed each call.
 */
export async function buildStudioStatus(project: Project): Promise<StudioStatusDto> {
  const db = getDb();
  const env = getEnv();
  const [assets, tracks, generations, jobs, settings, worker] = await Promise.all([
    db.query.mediaAssets.findMany({ where: and(eq(schema.mediaAssets.projectId, project.id), isNull(schema.mediaAssets.deletedAt)) }),
    db.query.musicTracks.findMany({
      where: and(isNull(schema.musicTracks.projectId), isNull(schema.musicTracks.deletedAt)),
      orderBy: desc(schema.musicTracks.createdAt),
    }),
    db.query.generations.findMany({ where: eq(schema.generations.projectId, project.id), orderBy: desc(schema.generations.createdAt), limit: GENERATION_LIMIT }),
    db.query.jobs.findMany({
      where: and(eq(schema.jobs.projectId, project.id), inArray(schema.jobs.status, [...ACTIVE_JOB_STATUSES])),
      orderBy: desc(schema.jobs.createdAt),
      limit: 50,
    }),
    getSettings(),
    getWorkerStatus(),
  ]);
  const generationIds = generations.map((g) => g.id);
  const edits = generationIds.length
    ? await db.query.edits.findMany({ where: and(inArray(schema.edits.generationId, generationIds), isNull(schema.edits.deletedAt)) })
    : [];
  const editIds = edits.map((e) => e.id);
  const versions = editIds.length ? await db.query.editVersions.findMany({ where: inArray(schema.editVersions.editId, editIds) }) : [];

  const cache = new Map<string, Promise<string | null>>();
  const sign: LinkSigner = (key) => {
    let link = cache.get(key);
    if (!link) {
      link = maybeSignedUrl(key);
      cache.set(key, link);
    }
    return link;
  };

  return shapeStudioStatus(
    {
      project,
      assets,
      tracks,
      generations,
      edits,
      versions,
      jobs: jobs.map((j) => toJobDto(j)),
      settings,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
      mediaLinkTtlSeconds: env.MEDIA_LINK_TTL_SECONDS,
      partSize: UPLOAD_PART_SIZE,
      worker,
    },
    sign,
  );
}
