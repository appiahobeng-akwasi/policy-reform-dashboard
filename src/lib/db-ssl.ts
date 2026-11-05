// Encrypted, verified database connections (decision 91). DATABASE_SSL_CA holds the root
// certificate the database's certificate must chain to (PEM, or the PEM in base64 so it fits
// on one line in an env file). When it is set, both the app (node-postgres) and the backup
// tools (libpq: pg_dump, pg_restore) check the certificate and the host name. When it is not
// set, the address decides: a local database needs no encryption, and sslmode=verify-full
// without a certificate is refused rather than quietly left unchecked.
import type pg from 'pg';

/** The root certificate as PEM, from PEM or base64 PEM; null when unset or not a certificate. */
export function decodeCa(value: string | undefined | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const pem = raw.includes('-----BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  // The certificate block(s) only: a file may carry comment lines around it.
  const blocks = pem.replace(/\\n/g, '\n').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  return blocks ? `${blocks.join('\n')}\n` : null;
}

const SSL_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

/** The address without its TLS settings, which node-postgres would otherwise let override ours. */
export function withoutSslParams(url: string): string {
  const parsed = new URL(url);
  for (const key of SSL_PARAMS) parsed.searchParams.delete(key);
  return parsed.toString();
}

/** How node-postgres should connect: verified against the root certificate when there is one. */
export function pgConnection(url: string, ca: string | null): Pick<pg.ClientConfig, 'connectionString' | 'ssl'> {
  if (ca) return { connectionString: withoutSslParams(url), ssl: { ca, rejectUnauthorized: true } };
  const mode = new URL(url).searchParams.get('sslmode');
  if (mode === 'verify-full' || mode === 'verify-ca') {
    throw new Error('The database address asks for a verified connection (sslmode=verify-full) but DATABASE_SSL_CA is not set.');
  }
  return { connectionString: url };
}

/**
 * The address as libpq (pg_dump, pg_restore) reads it. With a root certificate file: verify the
 * certificate and host name. Without one, node's "no-verify" becomes libpq's "require".
 */
export function libpqUrl(url: string, caFile: string | null = null): string {
  const parsed = new URL(url);
  if (caFile) {
    parsed.searchParams.set('sslmode', 'verify-full');
    parsed.searchParams.set('sslrootcert', caFile);
    return parsed.toString();
  }
  if (parsed.searchParams.get('sslmode') === 'no-verify') parsed.searchParams.set('sslmode', 'require');
  return parsed.toString();
}
