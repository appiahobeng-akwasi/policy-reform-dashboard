// The shared secret a scheduler sends to POST /api/jobs/<name> (decision 50).
import { timingSafeEqual } from 'node:crypto';

/** True only for "Bearer <secret>" with the configured secret; always false when none is set. */
export function secretMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
