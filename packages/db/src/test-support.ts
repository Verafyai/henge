/** Test helpers: a registered verifier worker key that signs machine-check verdicts. Never imported by app code. */
import { generateKeyPairSync } from 'node:crypto';
import { recordPayload, signingKeyFromPkcs8, signRecord, type SigningKey } from '@swarm-explorer/verify';
import { machineCheckWork, recordWorkerVerdict, registerWorkerKeysFromEnv, type WorkItem } from './verification';

let worker: SigningKey | null = null;

export async function testWorker(): Promise<SigningKey> {
  if (worker) return worker;
  const pkcs8 = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
  worker = signingKeyFromPkcs8(`test-worker-${Math.random().toString(36).slice(2, 10)}`, pkcs8);
  await registerWorkerKeysFromEnv(`${worker.keyId}=${worker.publicKey}`);
  return worker;
}

/** Signs and records a machine-check verdict for one work item, as the verifier worker would. */
export async function postMachineVerdict(item: WorkItem, outcome: 'accepted' | 'rejected', rationaleCode = outcome === 'accepted' ? 'test_accepted' : 'test_rejected', now?: Date) {
  const key = await testWorker();
  const payload = recordPayload(item.subject, 'machine-check', item.output_sha256, { outcome, rationaleCode, evidenceHashes: [], verifierVersion: 'test-checker-v1' });
  return recordWorkerVerdict({ keyId: key.keyId, payload, signature: signRecord(key, payload), ...(now ? { now } : {}) });
}

/** Accepts (or rejects) every machine check waiting right now. */
export async function settleMachineChecks(outcome: 'accepted' | 'rejected' = 'accepted') {
  const items = await machineCheckWork(100);
  for (const i of items) await postMachineVerdict(i, outcome);
  return items.length;
}
