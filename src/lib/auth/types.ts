// What the app needs from a sign-in provider. The Supabase adapter in src/lib/platform
// implements it; another provider would implement the same shape.

/** Verified claims of the signed-in session. Passed to Postgres as request.jwt.claims. */
export type AuthClaims = {
  sub: string;
  email?: string;
  aal?: string;
  role?: string;
  [claim: string]: unknown;
};

export type TotpEnrolment = { factorId: string; qrCode: string; secret: string };

export interface Auth {
  /** Claims of the current session, verified, or null when signed out. */
  claims(): Promise<AuthClaims | null>;
  /** Emails a one-time sign-in link. Returns false if the provider refused or failed. */
  sendSignInLink(email: string): Promise<boolean>;
  /** Turns the token hash from a sign-in link into a session. Null if the link is invalid or used. */
  verifySignInLink(tokenHash: string): Promise<AuthClaims | null>;
  signOut(): Promise<void>;
  mfa: {
    /** The user's confirmed authenticator app, if they have set one up. */
    verifiedTotpFactor(): Promise<string | null>;
    /** Starts set-up of an authenticator app, replacing any unfinished set-up. */
    enrolTotp(): Promise<TotpEnrolment | null>;
    /** Checks a 6-digit code. On success the session moves to the second assurance level (aal2). */
    verify(factorId: string, code: string): Promise<boolean>;
  };
}

/** Admin actions on sign-in identities. Null from the factory when the host has no admin key. */
export interface AuthAdmin {
  /** Which of these sign-in identities (auth_user_id) have a confirmed authenticator app. */
  withAuthenticator(authUserIds: string[]): Promise<Set<string>>;
  /** Removes every authenticator app of this identity. Returns how many were removed. */
  removeAuthenticator(authUserId: string): Promise<number>;
  /**
   * A one-time sign-in token for this email, without sending anything (decision 88: the admin
   * passes the link on when email is not set up). The token hash goes in /auth/confirm.
   */
  createSignInToken(email: string): Promise<string | null>;
}
