import { glyphV1Schema } from '@swarm-explorer/schema';
import { schemaResponse } from '@/lib/schema-response';

export const dynamic = 'force-static';

/** GET /schema/glyph-v1.json: the Glyph manifest v1 JSON Schema. */
export function GET() {
  return schemaResponse(glyphV1Schema);
}
