import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import { LANG_COOKIE, resolveLanguage } from './i18n';
import { createAuth } from './lib/auth';
import { isAllowedBeforeMfa, isPublicPath, needsMfa, signInPath } from './lib/auth/access';
import { findProfile } from './lib/server-db';
import { logError, plainPage } from './lib/errors';
import { createMailer } from './lib/platform/smtp-email';
import { checkBody } from './lib/security/body-limit';
import { withSecurityHeaders } from './lib/security/headers';
import { allow, clientIp, ruleFor } from './lib/security/rate-limit';
import { t } from './i18n';
import { env } from './lib/env';

// For every request: who is signed in, which language to show, and whether they may open
// the page. The database still decides what they see (row-level security); this only
// sends people to the right page.
export const onRequest = defineMiddleware(async (context, next) => {
  let response: Response;
  try {
    response = await route(context, next);
  } catch (error) {
    // Any server error: logged with a reference; the person sees the reference, never the detail.
    const reference = await logError(
      { source: 'request', error, method: context.request.method, path: context.url.pathname, status: 500, userId: context.locals.user?.userId ?? null },
      createMailer(),
    );
    const lang = context.locals.lang ?? 'en';
    response = plainPage(lang, 500, t(lang, 'errors.server_title'), t(lang, 'errors.server_body', { reference }));
  }
  return withSecurityHeaders(response, { https: context.url.protocol === 'https:', personal: context.locals.user != null });
});

async function route(context: APIContext, next: MiddlewareNext): Promise<Response> {
  // Body size first (decision 91): nothing is parsed, not even the session, for a body that is
  // too large or of unknown length.
  const body = checkBody(context.request.method, context.url.pathname, context.request.headers.get('content-length'));
  if (body !== 'ok') {
    const lang = resolveLanguage({ profile: null, cookie: context.cookies.get(LANG_COOKIE)?.value ?? null, acceptLanguage: context.request.headers.get('accept-language') });
    const status = body === 'too_large' ? 413 : 411;
    return plainPage(lang, status, t(lang, 'errors.too_large_title'), t(lang, body === 'too_large' ? 'errors.too_large_body' : 'errors.length_required_body'));
  }

  const auth = createAuth(context.cookies, context.request);
  context.locals.auth = auth;

  const claims = await auth.claims();
  const profile = claims ? await findProfile(claims.sub) : null;
  context.locals.user = claims && profile ? { ...profile, claims, aal: typeof claims.aal === 'string' ? claims.aal : 'aal1' } : null;

  context.locals.lang = resolveLanguage({
    profile: profile?.lang ?? null,
    cookie: context.cookies.get(LANG_COOKIE)?.value ?? null,
    acceptLanguage: context.request.headers.get('accept-language'),
  });

  const { pathname, search } = context.url;
  const user = context.locals.user;
  if (!user && !isPublicPath(pathname)) {
    return context.redirect(signInPath(pathname + search), 303);
  }
  if (user && needsMfa(user) && !isAllowedBeforeMfa(pathname)) {
    return context.redirect(`/auth/mfa?next=${encodeURIComponent(pathname + search)}`, 303);
  }

  // Rate limits (decision 63): only on sending, never on reading.
  const rule = ruleFor(context.request.method, pathname);
  const ip = clientIp(context.request, context.clientAddress);
  const exempt = rule?.by === 'ip' && env.rateLimitIpExempt.includes(ip);
  if (rule && !exempt) {
    const key = rule.by === 'user' && user ? user.userId : ip;
    if (!(await allow(rule.limit, key))) {
      console.warn(JSON.stringify({ level: 'warn', at: new Date().toISOString(), event: 'rate_limited', bucket: rule.limit.bucket, path: pathname }));
      const lang = context.locals.lang;
      const minutes = Math.ceil(rule.limit.windowSeconds / 60);
      const wantsJson = (context.request.headers.get('accept') ?? '').includes('application/json') || pathname.startsWith('/api/');
      const response = wantsJson
        ? Response.json({ ok: false, reason: 'rate_limited' }, { status: 429 })
        : plainPage(lang, 429, t(lang, 'errors.too_many_title'), t(lang, 'errors.too_many_body', { minutes }));
      response.headers.set('retry-after', String(rule.limit.windowSeconds));
      return response;
    }
  }
  return next();
}
