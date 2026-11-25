import { modelFitSchema } from '@swarm-explorer/api-client';
import { getModel, latestCapabilities } from '@swarm-explorer/db';
import { estimateFit, fitReasonText } from '@swarm-explorer/node-core';
import { z } from 'zod';
import { apiError, json } from '@/lib/api';
import { ownedNode, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/models/{id}/fit?node_id= (SPEC 13.1): estimated fit before download, from the node's
 * latest minimized capability report. Memory facts only; no speed claims (SPEC 5.4).
 */
export const GET = withNodeAuth<{ params: Promise<{ id: string }> }>(
  async (req, { user, install }, { params }) => {
    const nodeId = z.uuid().safeParse(new URL(req.url).searchParams.get('node_id'));
    if (!nodeId.success) return apiError(400, 'invalid_node_id', 'node_id must be a node id.');
    const node = await ownedNode(user, install.id, nodeId.data);
    if (!node) return apiError(404, 'not_found', 'No such node.');
    const model = await getModel((await params).id);
    if (!model) return apiError(404, 'not_found', 'No such model.');
    const caps = await latestCapabilities(node.id);
    const facts = caps
      ? { ramBytes: caps.ramBytes, gpuFamily: caps.gpuFamily, vramBytes: caps.vramBytes, unified: caps.gpuFamily === 'apple' }
      : { ramBytes: null, gpuFamily: null, vramBytes: null, unified: false };
    return json(modelFitSchema, {
      model: model.model.slug,
      node_id: node.id,
      observed_at: caps ? caps.observedAt.toISOString() : null,
      artifacts: model.artifacts.map((a) => {
        const f = estimateFit(a.sizeBytes, facts);
        return { content_hash: a.contentHash, fit_status: f.status, basis: 'estimate' as const, reason: fitReasonText[f.reason] };
      }),
    });
  },
  { write: false },
);
