// Sign-in through Supabase Auth. The only file that talks to Supabase Auth (CLAUDE.md rule 7).
// Runs on the server only: the browser gets httpOnly session cookies and never sees a token.
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { AstroCookies } from 'astro';
import type { Auth, AuthClaims } from '../auth/types';
import { env } from '../env';

/** Session cookies are named sb-<project>-auth-token; no such cookie means signed out. */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  return /(^|;\s*)sb-[^=]+-auth-token/.test(cookieHeader ?? '');
}

export function createSupabaseAuth(cookies: AstroCookies, request: Request): Auth {
  const cookieHeader = request.headers.get('cookie');
  const supabase = createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { flowType: 'pkce' },
    cookies: {
      getAll: () => parseCookieHeader(cookieHeader ?? '').map(({ name, value }) => ({ name, value: value ?? '' })),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) {
          cookies.set(name, value, { ...options, path: '/', httpOnly: true, sameSite: 'lax', secure: import.meta.env.PROD });
        }
      },
    },
  });

  return {
    async claims() {
      if (!hasSessionCookie(cookieHeader)) return null;
      const { data, error } = await supabase.auth.getClaims();
      if (error || !data?.claims?.sub) return null;
      return data.claims as AuthClaims;
    },

    async sendSignInLink(email) {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: `${env.appBaseUrl}/auth/confirm` },
      });
      return !error;
    },

    async verifySignInLink(tokenHash) {
      const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
      if (error || !data.session) return null;
      const verified = await supabase.auth.getClaims();
      return (verified.data?.claims as AuthClaims | undefined) ?? null;
    },

    async signOut() {
      await supabase.auth.signOut({ scope: 'local' });
    },

    mfa: {
      async verifiedTotpFactor() {
        const { data } = await supabase.auth.mfa.listFactors();
        return data?.totp[0]?.id ?? null;
      },

      async enrolTotp() {
        const factors = await supabase.auth.mfa.listFactors();
        for (const factor of factors.data?.all ?? []) {
          if (factor.factor_type === 'totp' && factor.status === 'unverified') {
            await supabase.auth.mfa.unenroll({ factorId: factor.id });
          }
        }
        const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Pillar 1 dashboard' });
        if (error || !data) return null;
        return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
      },

      async verify(factorId, code) {
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
        return !error;
      },
    },
  };
}
