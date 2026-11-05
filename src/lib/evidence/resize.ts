// Photos are made smaller in the browser before sending (docs/01 section 5.1): at most 1600 px
// on the long edge, JPEG quality 0.7.
export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.7;
/** Already-small JPEGs are sent as they are. */
export const SMALL_ENOUGH_BYTES = 1_000_000;

export function targetSize(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function needsShrinking(type: string, bytes: number, width: number, height: number): boolean {
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return false;
  return Math.max(width, height) > MAX_EDGE || bytes > SMALL_ENOUGH_BYTES || type !== 'image/jpeg';
}

export function jpegName(name: string): string {
  return /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, '.jpg') : `${name}.jpg`;
}
