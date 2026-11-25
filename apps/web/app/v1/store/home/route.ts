import { storeHomeSchema } from '@swarm-explorer/api-client';
import { categories } from '@swarm-explorer/core';
import { getDb, listSwarms, nodeMemberships, nodes, openLeases, queueCounts } from '@swarm-explorer/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apiError, json, toSwarmSummary } from '@/lib/api';
import { toMembershipView } from '@/lib/membership-api';
import { ownedNode, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** GET /v1/store/home?node_id= (SPEC 13.1, 4.2): joined swarms first, then up to three featured, then categories. */
export const GET = withNodeAuth(
  async (req, { user, install }) => {
    const nodeId = z.uuid().safeParse(new URL(req.url).searchParams.get('node_id'));
    if (!nodeId.success) return apiError(400, 'invalid_node', 'Pass node_id.');
    if (!(await ownedNode(user, install.id, nodeId.data))) return apiError(404, 'not_found', 'No such node.');
    const [joined, listed] = await Promise.all([nodeMemberships(user.id, nodeId.data), listSwarms()]);
    const [queue, open, db] = await Promise.all([queueCounts(joined.map((j) => ({ swarmId: j.swarm.id, harnessReleaseId: j.release.harnessReleaseId, permissionsHash: j.release.permissionsHash }))), openLeases(nodeId.data), getDb()]);
    const [node] = await db.select({ customized: nodes.sharesCustomized }).from(nodes).where(eq(nodes.id, nodeId.data));
    const views = joined.map((j) => toMembershipView(j, queue));
    const qualified = views.filter((v) => v.status === 'active' || v.status === 'paused' || v.status === 'reconsent_required');
    return json(storeHomeSchema, {
      joined: views,
      featured: listed.filter((r) => r.swarm.featuredStatus === 'featured').slice(0, 3).map(toSwarmSummary),
      categories: categories.map((c) => ({ key: c.key, label: c.label, listed: listed.filter((r) => r.swarm.category === c.key).length })),
      node: {
        id: nodeId.data,
        qualified_swarms: qualified.length,
        share_total_bp: qualified.reduce((a, v) => a + v.share_bp, 0),
        shares_customized: node?.customized ?? false,
        open_leases: open.map((l) => ({ id: l.id, swarm: l.swarm, status: l.status, deadline_at: l.deadlineAt.toISOString() })),
      },
    });
  },
  { write: false },
);
