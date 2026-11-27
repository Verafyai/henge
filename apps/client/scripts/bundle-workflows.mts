/**
 * Prebuilds the node's Temporal workflow bundle (src/main/temporal/workflows.ts) into
 * out/main/workflow-bundle.js after `electron-vite build`, so the app never bundles workflow code
 * at run time. The worker loads it with `workflowBundle: { codePath }`.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

const appDir = path.resolve(import.meta.dirname, '..');
const quiet = { log: () => {}, trace: () => {}, debug: () => {}, info: () => {}, warn: (m: string) => console.warn(m), error: (m: string) => console.error(m) };
const { code } = await bundleWorkflowCode({ workflowsPath: path.join(appDir, 'src', 'main', 'temporal', 'workflows.ts'), logger: quiet });
const out = path.join(appDir, 'out', 'main', 'workflow-bundle.js');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, code);
console.log(`Workflow bundle written to ${path.relative(appDir, out)} (${code.length} bytes).`);
