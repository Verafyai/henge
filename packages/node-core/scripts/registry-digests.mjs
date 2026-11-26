#!/usr/bin/env node
/**
 * Pulls real pins for Ollama catalog candidates (DECISIONS 2026-11-25, "Model catalog").
 *
 * For each tag it fetches the registry manifest and reports:
 * - digest: sha256 of the manifest bytes, the value `ollama` reports for the tag and the catalog pins (M2);
 * - sizeBytes: the sum of the manifest's layers (what a pull downloads);
 * - the model, params and license layers, with the license text's first non-empty line.
 *
 * Usage: node registry-digests.mjs qwen2.5:7b-instruct-q4_K_M phi4:14b ... [--json]
 * Read-only: it only GETs public manifests and the small license and params blobs.
 */
import { createHash } from 'node:crypto';

const REGISTRY = 'https://registry.ollama.ai/v2';
const ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';

function split(ref) {
  const [path, tag = 'latest'] = ref.split(':');
  return { repo: path.includes('/') ? path : `library/${path}`, tag };
}

async function blobText(repo, digest, limit = 4096) {
  const res = await fetch(`${REGISTRY}/${repo}/blobs/${digest}`, { redirect: 'follow' });
  if (!res.ok) return null;
  const text = await res.text();
  return text.slice(0, limit);
}

export async function pin(ref) {
  const { repo, tag } = split(ref);
  const res = await fetch(`${REGISTRY}/${repo}/manifests/${tag}`, { headers: { Accept: ACCEPT } });
  if (!res.ok) return { ref, error: `manifest HTTP ${res.status}` };
  const bytes = Buffer.from(await res.arrayBuffer());
  const manifest = JSON.parse(bytes.toString('utf8'));
  const layers = manifest.layers ?? [];
  const byType = (t) => layers.find((l) => l.mediaType === `application/vnd.ollama.image.${t}`);
  const model = byType('model');
  const license = byType('license');
  const params = byType('params');
  const licenseText = license ? await blobText(repo, license.digest) : null;
  return {
    ref,
    digest: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: layers.reduce((n, l) => n + (l.size ?? 0), 0) + (manifest.config?.size ?? 0),
    modelLayerBytes: model?.size ?? null,
    licenseFirstLine: licenseText?.split('\n').map((s) => s.trim()).find(Boolean) ?? null,
    params: params ? await blobText(repo, params.digest, 1024) : null,
  };
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const refs = args.filter((a) => !a.startsWith('--'));
if (!refs.length) {
  console.error('usage: registry-digests.mjs <ollama-tag>... [--json]');
  process.exit(2);
}
const out = [];
for (const ref of refs) out.push(await pin(ref));
if (asJson) console.log(JSON.stringify(out, null, 2));
else
  for (const r of out)
    console.log(r.error ? `${r.ref}\tERROR ${r.error}` : `${r.ref}\t${r.digest}\t${(r.sizeBytes / 1e9).toFixed(2)} GB\t${r.licenseFirstLine}`);
