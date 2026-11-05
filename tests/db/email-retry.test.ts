// Emails that fail are tried again (decision 92, migration 0022): a failed send is claimed again
// by a later run, at most three tries in all; a sent one is never sent twice.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import type { Mailer } from '../../src/lib/email/mailer';
import { MAX_EMAIL_ATTEMPTS, sendOnce, type Recipient } from '../../src/lib/jobs/run';
import { closePool } from '../../src/lib/server-db';

let client: pg.Client;
const people: string[] = [];
const DAY = '2026-11-02';

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client.query('delete from notification_log where person_id = any ($1)', [people]);
  await client.query('delete from people where person_id = any ($1)', [people]);
  await client?.end();
  await closePool();
});

async function person(): Promise<Recipient> {
  const { rows } = await client.query<{ person_id: string }>("insert into people (full_name, email) values ('Retry test', null) returning person_id");
  people.push(rows[0]!.person_id);
  return { personId: rows[0]!.person_id, name: 'Retry test', email: 'retry@example.test', lang: 'en' };
}

/** A mailer that fails the first `failures` sends, then succeeds. */
function flaky(failures: number): Mailer & { calls: number } {
  const mailer = {
    calls: 0,
    async send() {
      mailer.calls += 1;
      if (mailer.calls <= failures) throw new Error('SMTP down');
      return `msg-${mailer.calls}`;
    },
  };
  return mailer as Mailer & { calls: number };
}

const build = () => ({ subject: 'Reminders', text: 'x', html: '<p>x</p>' });
const row = async (personId: string) =>
  (await client.query<{ status: string; attempts: number }>("select status, attempts from notification_log where kind = 'email_sent' and person_id = $1", [personId])).rows;

describe('sendOnce', () => {
  it('a failed email is sent on the next try, then never again', async () => {
    const who = await person();
    const mailer = flaky(1);
    expect(await sendOnce(who, 'daily', DAY, build, mailer)).toBe('failed');
    expect(await row(who.personId)).toEqual([{ status: 'failed', attempts: 1 }]);
    expect(await sendOnce(who, 'daily', DAY, build, mailer)).toBe('sent');
    expect(await row(who.personId)).toEqual([{ status: 'sent', attempts: 2 }]);
    expect(await sendOnce(who, 'daily', DAY, build, mailer)).toBe('already');
    expect(mailer.calls).toBe(2);
  });

  it(`stops after ${MAX_EMAIL_ATTEMPTS} tries`, async () => {
    const who = await person();
    const mailer = flaky(99);
    for (let i = 0; i < MAX_EMAIL_ATTEMPTS; i++) expect(await sendOnce(who, 'daily', DAY, build, mailer)).toBe('failed');
    expect(await sendOnce(who, 'daily', DAY, build, mailer)).toBe('already');
    expect(await row(who.personId)).toEqual([{ status: 'failed', attempts: MAX_EMAIL_ATTEMPTS }]);
    expect(mailer.calls).toBe(MAX_EMAIL_ATTEMPTS);
  });

  it('a sent email is not sent twice', async () => {
    const who = await person();
    const mailer = flaky(0);
    expect(await sendOnce(who, 'weekly', DAY, build, mailer)).toBe('sent');
    expect(await sendOnce(who, 'weekly', DAY, build, mailer)).toBe('already');
    expect(mailer.calls).toBe(1);
  });
});
