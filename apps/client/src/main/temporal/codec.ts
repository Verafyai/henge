/**
 * Encrypts every Temporal payload before it reaches the local server's SQLite file, the same way
 * the encrypted cache protects its rows (AES-256-GCM, a key derived from the keychain-held cache
 * key). Task inputs, outputs, run records and Henge manifests are therefore never stored in plain
 * text in userData. Failure messages stay plain (encoding them needs a converter inside the
 * workflow sandbox); activities only ever fail with short messages that carry no task data.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Payload, PayloadCodec } from '@temporalio/common';

const ENCODING = 'binary/henge-aes-256-gcm-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

export class EncryptionCodec implements PayloadCodec {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('The payload key must be 32 bytes.');
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((p) => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', this.key, iv);
      // The original payload (metadata and data) is encrypted whole.
      const plain = Buffer.from(JSON.stringify({ m: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v ?? new Uint8Array()).toString('base64')])), d: Buffer.from(p.data ?? new Uint8Array()).toString('base64') }));
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return { metadata: { encoding: enc.encode(ENCODING) }, data: Buffer.concat([iv, c.getAuthTag(), ct]) };
    });
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((p) => {
      if (!p.metadata?.['encoding'] || dec.decode(p.metadata['encoding']) !== ENCODING) return p;
      const buf = Buffer.from(p.data ?? new Uint8Array());
      const d = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      const o = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as { m: Record<string, string>; d: string };
      return { metadata: Object.fromEntries(Object.entries(o.m).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))])), data: new Uint8Array(Buffer.from(o.d, 'base64')) };
    });
  }
}
