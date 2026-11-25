import { registerInstallResponseSchema, registerInstallSchema } from '@swarm-explorer/api-client';
import { can } from '@swarm-explorer/core';
import { getDb, installs, nodes } from '@swarm-explorer/db';
import { DEFAULT_RUN_RULES } from '@swarm-explorer/node-core';
import { eq } from 'drizzle-orm';
import { apiError, json } from '@/lib/api';
import { withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** A generic name: no hostname or user name leaves the device (SPEC 12 minimization). */
const nodeName = (platform: string) => ({ darwin: 'Mac node', win32: 'Windows node', linux: 'Linux node' })[platform] ?? 'Node';

/**
 * POST /v1/installs (SPEC 13.1). The token exchange already created the install and bound its
 * device key; this records the running version and channel and creates the install's node once.
 */
export const POST = withNodeAuth(async (_req, { user, install, body }) => {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    raw = null;
  }
  const parsed = registerInstallSchema.safeParse(raw);
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send app_version, channel, platform and arch.');
  if (!can(user, 'install.register', install)) return apiError(403, 'forbidden', 'Not allowed.');
  const d = parsed.data;
  const db = await getDb();
  await db
    .update(installs)
    .set({ clientVersion: d.app_version, channel: d.channel, platform: d.platform, arch: d.arch, lastSeenAt: new Date() })
    .where(eq(installs.id, install.id));
  await db
    .insert(nodes)
    .values({ installId: install.id, accountId: user.id, name: nodeName(d.platform), runRulesJson: DEFAULT_RUN_RULES })
    .onConflictDoNothing({ target: nodes.installId });
  const [node] = await db.select({ id: nodes.id, status: nodes.status }).from(nodes).where(eq(nodes.installId, install.id)).limit(1);
  return json(registerInstallResponseSchema, { install_id: install.id, node_id: node!.id, node_status: node!.status });
});
