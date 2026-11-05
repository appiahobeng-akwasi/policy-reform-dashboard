/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    lang: import('./i18n').Lang;
    auth: import('./lib/auth').Auth;
    /** The signed-in user, or null. aal2 means the session has passed MFA. */
    user:
      | (import('./lib/server-db').Profile & {
          claims: import('./lib/auth').AuthClaims;
          aal: string;
        })
      | null;
  }
}
