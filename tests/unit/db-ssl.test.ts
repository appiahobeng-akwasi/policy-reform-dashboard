// Verified database connections (decision 91).
import { describe, expect, it } from 'vitest';
import { decodeCa, libpqUrl, pgConnection, withoutSslParams } from '../../src/lib/db-ssl';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----\n';
const HOSTED = 'postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=verify-full';

describe('decodeCa', () => {
  it('reads a PEM, a base64 PEM, or one with escaped line breaks', () => {
    expect(decodeCa(PEM)).toBe(PEM);
    expect(decodeCa(Buffer.from(PEM).toString('base64'))).toBe(PEM);
    expect(decodeCa(PEM.replace(/\n/g, '\\n'))).toBe(PEM);
    expect(decodeCa(`# Supabase Root 2021 CA\n# not a secret\n${PEM}`)).toBe(PEM);
  });

  it('is null when unset or not a certificate', () => {
    expect(decodeCa(undefined)).toBeNull();
    expect(decodeCa('  ')).toBeNull();
    expect(decodeCa(Buffer.from('not a cert').toString('base64'))).toBeNull();
  });
});

describe('pgConnection', () => {
  it('with a root certificate: checks the certificate and host name, whatever the address says', () => {
    const config = pgConnection(HOSTED, PEM);
    expect(config.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(config.connectionString).not.toContain('sslmode');
  });

  it('a verified address without a certificate is refused, never quietly unchecked', () => {
    expect(() => pgConnection(HOSTED, null)).toThrow(/DATABASE_SSL_CA is not set/);
  });

  it('a local address needs nothing', () => {
    expect(pgConnection('postgresql://postgres:postgres@127.0.0.1:54322/postgres', null)).toEqual({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
  });

  it('drops only the TLS settings from the address', () => {
    expect(withoutSslParams('postgresql://u:p@h:5432/db?sslmode=require&application_name=x&sslrootcert=/tmp/c')).toBe('postgresql://u:p@h:5432/db?application_name=x');
  });
});

describe('libpqUrl', () => {
  it('with a certificate file: verify-full and the file', () => {
    expect(libpqUrl(HOSTED, '/tmp/root.crt')).toBe(`${HOSTED.replace('6543', '6543')}&sslrootcert=%2Ftmp%2Froot.crt`);
  });

  it("without one: node's no-verify becomes libpq's require; others unchanged", () => {
    expect(libpqUrl('postgresql://u:p@h:5432/postgres?sslmode=no-verify')).toBe('postgresql://u:p@h:5432/postgres?sslmode=require');
    expect(libpqUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  });
});
