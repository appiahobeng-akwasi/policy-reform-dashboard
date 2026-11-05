// Remembers the page someone asked for while they sign in. A cookie, not the sign-in link,
// so the email link stays short; opened on another device, the link goes to the home page.
import type { AstroCookies } from 'astro';
import { safeReturnPath } from '../http';

const NEXT_COOKIE = 'after_sign_in';

export function rememberNext(cookies: AstroCookies, next: unknown): void {
  cookies.set(NEXT_COOKIE, safeReturnPath(next), { path: '/', maxAge: 3600, httpOnly: true, sameSite: 'lax', secure: import.meta.env.PROD });
}

export function takeNext(cookies: AstroCookies): string {
  const next = safeReturnPath(cookies.get(NEXT_COOKIE)?.value);
  cookies.delete(NEXT_COOKIE, { path: '/' });
  return next;
}
