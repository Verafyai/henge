import { hengeV1Schema } from '@swarm-explorer/schema';
import { schemaResponse } from '@/lib/schema-response';

export const dynamic = 'force-static';

/** GET /schema/henge-v1.json: the `.henge` v1 JSON Schema (its `$id` is this URL). */
export function GET() {
  return schemaResponse(hengeV1Schema);
}
