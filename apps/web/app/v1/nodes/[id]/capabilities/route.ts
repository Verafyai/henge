import { capabilitiesAcceptedSchema } from '@swarm-explorer/api-client';
import { can } from '@swarm-explorer/core';
import { getDb, nodeCapabilities, nodes } from '@swarm-explorer/db';
import { capabilityReportSchema } from '@swarm-explorer/node-core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apiError, json } from '@/lib/api';
import { withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * PUT /v1/nodes/{node_id}/capabilities (SPEC 13.1): the minimized hardware and run-rule
 * enforcement report. The schema rejects unrounded sizes and unknown fields, so a client cannot
 * send more than SPEC 12.1 allows.
 */
export const PUT = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, { user, install, body }, { params }) => {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError(400, 'invalid_id', 'That node id is not valid.');
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    raw = null;
  }
  const parsed = capabilityReportSchema.strict().safeParse(raw);
  if (!parsed.success) return apiError(400, 'invalid_body', 'The capability report does not match the schema.', { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const db = await getDb();
  const [node] = await db.select().from(nodes).where(eq(nodes.id, id.data)).limit(1);
  // Same answer for "not yours" and "does not exist", so node ids cannot be probed.
  if (!node || !can(user, 'node.report', { accountId: node.accountId, installId: node.installId, callerInstallId: install.id })) {
    return apiError(404, 'not_found', 'No such node.');
  }
  const c = parsed.data;
  const observedAt = new Date();
  await db.insert(nodeCapabilities).values({
    nodeId: node.id,
    observedAt,
    os: c.os,
    cpuClass: c.cpu_class,
    ramBytes: c.ram_bytes,
    gpuFamily: c.gpu_family,
    vramBytes: c.vram_bytes,
    freeDiskBytes: c.free_disk_bytes,
    enforcementSupportJson: c.enforcement_support,
    confidence: c.confidence,
  });
  return json(capabilitiesAcceptedSchema, { node_id: node.id, observed_at: observedAt.toISOString() });
});
