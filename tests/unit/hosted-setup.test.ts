// Helpers behind npm run hosted:setup and the hosted backups (decision 88).
import { describe, expect, it } from 'vitest';
import { libpqUrl } from '../../scripts/lib/backup';
import { cleanPasted, githubSecrets, hostingTarget, pickSecretKey, poolerHosts, poolerUrl, readEnvFile, transactionPoolerUrl, updateEnvFile, vercelSecrets, withSslMode } from '../../scripts/lib/hosted';

describe('pooler addresses', () => {
  it('builds a verified session pooler address and escapes the password', () => {
    const url = poolerUrl({ ref: 'abc123', password: 'p@ss:w/rd#?', host: 'aws-0-eu-west-2.pooler.supabase.com', port: 5432 });
    expect(url).toBe('postgresql://postgres.abc123:p%40ss%3Aw%2Frd%23%3F@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full');
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss:w/rd#?');
  });

  it('turns an address saved before decision 91 into a verified one', () => {
    expect(withSslMode('postgresql://u:p@h:5432/postgres?sslmode=no-verify', 'verify-full')).toBe('postgresql://u:p@h:5432/postgres?sslmode=verify-full');
    expect(poolerUrl({ ref: 'abc', password: 'x', host: 'h', port: 5432, verified: false })).toContain('sslmode=no-verify');
  });

  it('refuses a project ref that is not one', () => {
    expect(() => poolerUrl({ ref: 'abc/../x', password: 'x', host: 'h', port: 5432 })).toThrow();
  });

  it('moves the app to the transaction pooler, keeping everything else', () => {
    expect(transactionPoolerUrl('postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=no-verify')).toBe(
      'postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=no-verify',
    );
  });

  it('tries both pooler hosts for the region', () => {
    expect(poolerHosts('eu-west-2')).toEqual(['aws-0-eu-west-2.pooler.supabase.com', 'aws-1-eu-west-2.pooler.supabase.com']);
  });

  it('gives pg_dump the libpq spelling of the same SSL setting', () => {
    expect(libpqUrl('postgresql://u:p@h:5432/postgres?sslmode=no-verify')).toBe('postgresql://u:p@h:5432/postgres?sslmode=require');
    expect(libpqUrl('postgresql://u:p@h:5432/postgres?a=1&sslmode=no-verify&b=2')).toBe('postgresql://u:p@h:5432/postgres?a=1&sslmode=require&b=2');
    expect(libpqUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  });
});

describe('pickSecretKey', () => {
  const keys = (extra: object[]) =>
    JSON.stringify([{ name: 'anon', type: 'legacy', api_key: 'eyJ.anon' }, { name: 'default', type: 'publishable', api_key: 'sb_publishable_x' }, ...extra]);

  it('takes the default secret key', () => {
    expect(pickSecretKey(keys([{ name: 'other', type: 'secret', api_key: 'sb_secret_other' }, { name: 'default', type: 'secret', api_key: 'sb_secret_default' }]))).toBe('sb_secret_default');
  });

  it('takes another secret key when there is no default', () => {
    expect(pickSecretKey(keys([{ name: 'app', type: 'secret', api_key: 'sb_secret_app' }]))).toBe('sb_secret_app');
  });

  it('falls back to the legacy service_role key when the secret key is masked', () => {
    const masked = { name: 'default', type: 'secret', api_key: 'sb_secret_j6N7q··························' };
    expect(pickSecretKey(keys([masked, { name: 'service_role', type: 'legacy', api_key: 'eyJ.service.role' }]))).toBe('eyJ.service.role');
  });

  it('never takes a publishable or anon key, or a masked one', () => {
    expect(pickSecretKey(keys([]))).toBeNull();
    expect(pickSecretKey(keys([{ name: 'default', type: 'secret', api_key: 'sb_secret_ab··' }]))).toBeNull();
    expect(pickSecretKey('not json')).toBeNull();
    expect(pickSecretKey('{"keys":[]}')).toBeNull();
  });
});

describe('env file', () => {
  const file = '# comment\nDATABASE_URL=\nAPP_BASE_URL=https://a.example\n\n# PASTE\nSUPABASE_SECRET_KEY=\n';

  it('fills lines in place and keeps comments and order', () => {
    const out = updateEnvFile(file, { DATABASE_URL: 'postgresql://x', SUPABASE_SECRET_KEY: 'sb_secret_1' });
    expect(out).toBe('# comment\nDATABASE_URL=postgresql://x\nAPP_BASE_URL=https://a.example\n\n# PASTE\nSUPABASE_SECRET_KEY=sb_secret_1\n');
  });

  it('adds new keys at the end and replaces on a second run', () => {
    const once = updateEnvFile(file, { BACKUP_PASSPHRASE: 'one' });
    expect(once.endsWith('SUPABASE_SECRET_KEY=\nBACKUP_PASSPHRASE=one\n')).toBe(true);
    const twice = updateEnvFile(once, { BACKUP_PASSPHRASE: 'two' });
    expect(readEnvFile(twice)['BACKUP_PASSPHRASE']).toBe('two');
    expect(twice.match(/BACKUP_PASSPHRASE/g)).toHaveLength(1);
  });

  it('refuses a value that would break the file', () => {
    expect(() => updateEnvFile(file, { DATABASE_URL: 'a\nEVIL=1' })).toThrow();
    expect(() => updateEnvFile(file, { 'bad-key': 'x' })).toThrow();
  });

  it('reads keys and values, skipping comments', () => {
    expect(readEnvFile('# x\nA=1\nB=two words <x@y>\n\n')).toEqual({ A: '1', B: 'two words <x@y>' });
  });

  it('cleans what copying adds', () => {
    expect(cleanPasted('  sb_secret_abc\r\n')).toBe('sb_secret_abc');
  });
});

describe('where each secret goes', () => {
  const env = {
    DATABASE_URL: 'postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=no-verify',
    SUPABASE_SECRET_KEY: 'sb_secret_1',
    S3_ENDPOINT: 'https://abc.storage.supabase.co/storage/v1/s3',
    S3_REGION: 'eu-west-2',
    S3_ACCESS_KEY_ID: 'id',
    S3_SECRET_ACCESS_KEY: 'secret',
    JOBS_SECRET: 'jobs',
    BACKUP_PASSPHRASE: 'phrase',
    DATABASE_SSL_CA: 'cert',
  };

  it('Vercel gets the transaction pooler and the app secrets, not the backup passphrase', () => {
    const vercel = Object.fromEntries(vercelSecrets(env));
    expect(new URL(vercel['DATABASE_URL']!).port).toBe('6543');
    expect(Object.keys(vercel).sort()).toEqual(['DATABASE_SSL_CA', 'DATABASE_URL', 'JOBS_SECRET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'SUPABASE_SECRET_KEY']);
  });

  it('GitHub gets the session pooler for backups and what the two workflows read', () => {
    const github = Object.fromEntries(githubSecrets(env));
    expect(new URL(github['BACKUP_DATABASE_URL']!).port).toBe('5432');
    expect(Object.keys(github).sort()).toEqual(['BACKUP_DATABASE_URL', 'BACKUP_PASSPHRASE', 'DATABASE_SSL_CA', 'JOBS_SECRET', 'S3_ACCESS_KEY_ID', 'S3_ENDPOINT', 'S3_REGION', 'S3_SECRET_ACCESS_KEY']);
  });

  it('stops on an empty value instead of sending a blank secret', () => {
    expect(() => vercelSecrets({ ...env, SUPABASE_SECRET_KEY: '' })).toThrow(/SUPABASE_SECRET_KEY is empty/);
  });
});

describe('the hosting target comes from .env.hosted, not the code (decision 95)', () => {
  const env = {
    SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
    S3_REGION: 'eu-west-2',
    VERCEL_PROJECT: 'my-dashboard',
    VERCEL_SCOPE: 'my-team',
    VERCEL_TEAM_ID: 'team_abc123',
    ADMIN_EMAIL: 'admin@example.org',
  };

  it('reads the project ref from the Supabase address and the rest from the file', () => {
    expect(hostingTarget(env)).toEqual({
      projectRef: 'abcdefghijklmnop',
      region: 'eu-west-2',
      vercelProject: 'my-dashboard',
      vercelScope: 'my-team',
      vercelTeamId: 'team_abc123',
      adminEmail: 'admin@example.org',
    });
  });

  it('names everything that is missing, and refuses a team ID of the wrong shape', () => {
    expect(() => hostingTarget({ SUPABASE_URL: 'http://127.0.0.1:54321' })).toThrow(
      'Set these in .env.hosted first: SUPABASE_URL (https://<project-ref>.supabase.co), VERCEL_PROJECT, VERCEL_SCOPE, VERCEL_TEAM_ID, ADMIN_EMAIL, S3_REGION.',
    );
    expect(() => hostingTarget({ ...env, VERCEL_TEAM_ID: 'my-team' })).toThrow('starts with team_');
  });
});
