/**
 * Avatar processing (spin-out spec 8.1 "Profiles"): PNG, JPEG or WebP up to 4 MB, cropped square,
 * re-encoded to a 256 px WebP. Re-encoding drops every metadata block, EXIF and GPS included; the EXIF
 * orientation is applied first so the picture stays upright. `sharp` is the library Next.js itself
 * uses for images and ships prebuilt binaries for Vercel's Linux runtime.
 */
import sharp from 'sharp';

export const AVATAR_MAX_BYTES = 4 * 1024 * 1024;
export const AVATAR_SIZE = 256;
/** Refuse decompression bombs: 40 megapixels is far beyond any real avatar. */
const MAX_INPUT_PIXELS = 40_000_000;

export type AvatarFormat = 'png' | 'jpeg' | 'webp';

export function sniffImage(b: Uint8Array): AvatarFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp';
  return null;
}

const CONTENT_TYPES: Record<string, AvatarFormat> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/webp': 'webp' };

export type Crop = { x: number; y: number; size: number };
export type AvatarResult = { ok: true; bytes: Uint8Array; contentType: 'image/webp' } | { ok: false; code: string; message: string };

export async function processAvatar(input: Uint8Array, contentType: string, crop: Crop | null): Promise<AvatarResult> {
  if (input.length > AVATAR_MAX_BYTES) return { ok: false, code: 'avatar_too_large', message: 'Avatars are at most 4 MB.' };
  const declared = CONTENT_TYPES[contentType.split(';')[0]!.trim().toLowerCase()];
  const actual = sniffImage(input);
  if (!declared || !actual) return { ok: false, code: 'avatar_type', message: 'Avatars are PNG, JPEG or WebP.' };
  if (declared !== actual) return { ok: false, code: 'avatar_type_mismatch', message: 'The file type does not match its contents.' };
  try {
    const oriented = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate().toBuffer({ resolveWithObject: true });
    const { width, height } = oriented.info;
    let img = sharp(oriented.data);
    if (crop) {
      const { x, y, size } = crop;
      if (![x, y, size].every((n) => Number.isInteger(n) && n >= 0) || size < 1 || x + size > width || y + size > height) {
        return { ok: false, code: 'avatar_crop_invalid', message: 'The crop square must sit inside the image.' };
      }
      img = img.extract({ left: x, top: y, width: size, height: size });
    }
    const out = await img.resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' }).webp({ quality: 85 }).toBuffer();
    return { ok: true, bytes: new Uint8Array(out), contentType: 'image/webp' };
  } catch {
    return { ok: false, code: 'avatar_unreadable', message: 'That image could not be read.' };
  }
}
