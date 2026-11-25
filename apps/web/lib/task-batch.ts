import { slugSchema, taskBatchAcceptedSchema, taskBatchSchema } from '@swarm-explorer/api-client';
import { uploadTasks } from '@swarm-explorer/db';
import { apiError, json, requireIdempotencyKey } from './api';
import { withBearer } from './bearer';
import { membershipErrorResponse } from './membership-api';

/**
 * POST /v1/swarms/{id}/tasks:batch (SPEC 13.4): the publisher uploads tasks to the hosted
 * coordinator. Bearer only, and only the publisher's owner account may upload; a publisher API key
 * arrives with publisher identity (M9). Idempotent by coordinator task id. Routed from the catch-all,
 * because a `tasks:batch` folder name is not portable.
 */
export const postTaskBatch = (slug: string) =>
  withBearer<undefined>(async (req, { user }) => {
    const idem = requireIdempotencyKey(req);
    if (idem instanceof Response) return idem;
    const s = slugSchema.safeParse(slug);
    let raw: unknown = null;
    try {
      raw = await req.json();
    } catch {
      raw = null;
    }
    const parsed = taskBatchSchema.safeParse(raw);
    if (!s.success || !parsed.success) return apiError(400, 'invalid_body', 'Send up to 500 tasks, each with a coordinator_task_id and an input object.');
    try {
      return json(taskBatchAcceptedSchema, await uploadTasks({ accountId: user.id, slug: s.data, tasks: parsed.data.tasks }), { status: 201 });
    } catch (e) {
      return membershipErrorResponse(e);
    }
  });
