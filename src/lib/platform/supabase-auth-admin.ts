// The sign-in provider's admin side: who has set up an authenticator app, removing one when
// a super administrator resets it (decision 45), and one-time sign-in links (decision 88).
// Server only, with the secret key; the only file that talks to Supabase's admin API
// (CLAUDE.md rule 7).
import { createClient } from '@supabase/supabase-js';
import type { AuthAdmin } from '../auth/types';
import { env } from '../env';

export function createSupabaseAuthAdmin(): AuthAdmin | null {
  const secretKey = env.supabaseSecretKey;
  if (!secretKey) return null;
  const supabase = createClient(env.supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async withAuthenticator(authUserIds) {
      // The user list does not carry factors, so each identity is asked; callers pass a page at most.
      const checked = await Promise.all(
        authUserIds.map(async (id) => {
          const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId: id });
          if (error) throw error;
          return data.factors.some((f) => f.factor_type === 'totp' && f.status === 'verified') ? id : null;
        }),
      );
      return new Set(checked.filter((id): id is string => id !== null));
    },

    async removeAuthenticator(authUserId) {
      const { data, error } = await supabase.auth.admin.mfa.listFactors({
        userId: authUserId,
      });
      if (error) throw error;
      // Removing a confirmed factor also signs the person out everywhere.
      for (const factor of data.factors) {
        const removed = await supabase.auth.admin.mfa.deleteFactor({
          id: factor.id,
          userId: authUserId,
        });
        if (removed.error) throw removed.error;
      }
      return data.factors.length;
    },

    async createSignInToken(email) {
      // Same kind of link as the sign-in email; the before-user-created hook still refuses
      // anyone not on the list.
      const { data, error } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
      if (error) return null;
      return data.properties?.hashed_token ?? null;
    },
  };
}
