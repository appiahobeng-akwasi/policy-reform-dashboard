# Platform adapters

Host-specific code lives here and nowhere else (CLAUDE.md rule 7). The rest of the app imports these adapters, never a vendor client directly, so the host can change by swapping an adapter and the environment variables.

| Adapter | Today | Interface |
|---|---|---|
| `supabase-auth.ts` | Sign-in through Supabase Auth: magic link with a one-time token, TOTP MFA, sessions in httpOnly cookies. Server-side only | `Auth` in `src/lib/auth/types.ts`, exported from `src/lib/auth/index.ts` |
| `supabase-auth-admin.ts` | The provider's admin API, with `SUPABASE_SECRET_KEY`: who has an authenticator app, resetting one, and one-time sign-in links for `npm run users:link` (decision 88). Server only | `AuthAdmin` in `src/lib/auth/types.ts` |
| `s3-storage.ts` | Evidence and upload files in any S3-compatible store (Supabase Storage today) | `S3_*` settings in `.env.example` |

The build adapter is chosen in `astro.config.mjs`: Node by default, Vercel with `ASTRO_ADAPTER=vercel` or on Vercel itself (decision 88).

Database access is not an adapter: the app uses plain Postgres through `src/lib/server-db.ts`, which works on any host.
