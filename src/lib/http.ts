/**
 * Where to send the user back to after a form post. Only paths on this site are
 * allowed, so a crafted form cannot redirect to another site ("//evil.example",
 * "/\evil.example" and full URLs all fall back to the home page).
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  return value;
}
