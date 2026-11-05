import type { APIRoute } from 'astro';
import { isLang, LANG_COOKIE, t } from '../../i18n';
import { needsMfa } from '../../lib/auth/access';
import { safeReturnPath } from '../../lib/http';
import { asUser } from '../../lib/server-db';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// The EN | FR switch posts here. Works without JavaScript. Signed-in users also get the
// choice saved to their profile (people.preferred_language), so it follows them to any device.
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const lang = form.get('lang');
  if (!isLang(lang)) {
    return new Response(t(locals.lang, 'language.invalid'), {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  cookies.set(LANG_COOKIE, lang, {
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
    sameSite: 'lax',
    httpOnly: true,
    secure: import.meta.env.PROD,
  });
  const user = locals.user;
  if (user && !needsMfa(user)) {
    await asUser(user.claims, (db) => db.query('select set_my_language($1)', [lang]));
  }
  return redirect(safeReturnPath(form.get('return_to')), 303);
};
