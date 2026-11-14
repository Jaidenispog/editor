import { handleApi, parseJson } from '@/lib/api';
import { GenerateRequestSchema, startGeneration } from '@/lib/studio-edits';

/** POST /api/projects/[id]/generate — creates the generation, one edit per style (v1 planning) and queues planning. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const settings = await parseJson(req, GenerateRequestSchema);
  const result = await startGeneration(params.id, user, settings);
  return Response.json(
    {
      generationId: result.generation.id,
      jobId: result.jobId,
      edits: result.edits.map((e) => ({ id: e.id, styleId: e.styleId, slot: e.slot, currentVersionId: e.currentVersionId })),
    },
    { status: 201 },
  );
});
