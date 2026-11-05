// The app's single entry point for sign-in. Swap the adapter here to change provider.
export { createSupabaseAuth as createAuth } from '../platform/supabase-auth';
export { createSupabaseAuthAdmin as createAuthAdmin } from '../platform/supabase-auth-admin';
export type { Auth, AuthAdmin, AuthClaims, TotpEnrolment } from './types';
