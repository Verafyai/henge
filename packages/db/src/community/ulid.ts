import { randomBytes } from 'node:crypto';

/** Crockford base32, as in the ULID spec. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomDigits(): number[] {
  const b = randomBytes(16);
  return Array.from({ length: 16 }, (_, i) => b[i]! % 32);
}

/**
 * Monotonic ULID: 48 bit milliseconds then 80 random bits. Within one millisecond the random part is
 * incremented, so ids from one process always sort in creation order.
 */
export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    // Same (or earlier) millisecond: increment the previous random part.
    const r = [...lastRandom];
    for (let i = r.length - 1; i >= 0; i--) {
      if (r[i]! < 31) {
        r[i]! += 1;
        break;
      }
      r[i] = 0;
    }
    lastRandom = r;
    return encodeTime(lastTime) + r.map((d) => ALPHABET[d]).join('');
  }
  lastTime = now;
  lastRandom = randomDigits();
  return encodeTime(now) + lastRandom.map((d) => ALPHABET[d]).join('');
}

/** Milliseconds encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}

/** The smallest ULID at a given millisecond, used as a lower bound in range scans. */
export function ulidFloor(ms: number): string {
  return encodeTime(Math.max(0, ms)) + '0'.repeat(16);
}
