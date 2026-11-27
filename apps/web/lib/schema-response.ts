/** JSON Schemas published at henge.verafy.ai/schema/*.json (spin-out spec v2, section 6). */
export const SCHEMA_CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

export function schemaResponse(schema: Record<string, unknown>): Response {
  return new Response(`${JSON.stringify(schema, null, 2)}\n`, {
    headers: {
      'content-type': 'application/schema+json; charset=utf-8',
      'cache-control': SCHEMA_CACHE_CONTROL,
      'access-control-allow-origin': '*',
    },
  });
}
