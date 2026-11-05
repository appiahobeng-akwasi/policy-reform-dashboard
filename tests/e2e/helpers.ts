import { createHmac, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { connect, databaseUrl, loadEnv } from '../../scripts/lib/db';
import { addUser, type NewUser } from '../../scripts/lib/users';

loadEnv();

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';
/** Unique per test run, so data and files from earlier runs never collide. */
export const RUN = Date.now().toString(36);

/** A new account for this test run. Emails are unique per run, so runs do not collide. */
export async function createAccount(label: string, user: Omit<NewUser, 'email' | 'name'>): Promise<string> {
  const email = `e2e-${RUN}-${label}@example.com`;
  const client = await connect(databaseUrl());
  try {
    await addUser(client, { ...user, email, name: `E2E ${label}` });
  } finally {
    await client.end();
  }
  return email;
}

export function unlistedEmail(label: string): string {
  return `e2e-${RUN}-${label}-unlisted@example.com`;
}

type MailSummary = { ID: string; Created: string };

async function messagesTo(email: string): Promise<MailSummary[]> {
  const response = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  if (!response.ok) throw new Error(`Mailpit search failed: ${response.status}`);
  const body = (await response.json()) as { messages: MailSummary[] };
  return body.messages;
}

export async function countEmailsTo(email: string): Promise<number> {
  return (await messagesTo(email)).length;
}

/** Waits for a new sign-in email (beyond `alreadySeen`) and returns its link. */
export async function signInLinkFor(email: string, alreadySeen = 0): Promise<string> {
  let messages: MailSummary[] = [];
  await expect.poll(async () => (messages = await messagesTo(email)).length, { timeout: 15_000 }).toBeGreaterThan(alreadySeen);
  const newest = messages.sort((a, b) => b.Created.localeCompare(a.Created))[0]!;
  const response = await fetch(`${MAILPIT}/api/v1/message/${newest.ID}`);
  const message = (await response.json()) as { HTML: string };
  const href = /href="([^"]*\/auth\/confirm\?token_hash=[^"]+)"/.exec(message.HTML)?.[1];
  if (!href) throw new Error('No sign-in link in the email');
  // The email links to the app's public address; open it on the test server instead (same path).
  const link = new URL(href.replace(/&amp;/g, '&'));
  return link.pathname + link.search;
}

/** Requests a link on the sign-in page, opens it from the email and confirms. */
export async function signIn(page: Page, email: string): Promise<void> {
  const before = await countEmailsTo(email);
  // Supabase refuses a second link to the same address within max_frequency (1 s locally).
  if (before > 0) await page.waitForTimeout(1500);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await signInLinkFor(email, before));
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// RFC 6238 time-based code, as an authenticator app would show it.
function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`Not base32: ${char}`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

/** A code from a later 30-second window than `used`, so no code is entered twice. */
export async function freshTotp(secret: string, used?: string): Promise<string> {
  let code = totp(secret);
  while (code === used) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    code = totp(secret);
  }
  return code;
}

/**
 * Puts a seeded milestone into a known state for one test and gives it an owner. These tests
 * change the local database; run `npm run db:reset` for a clean start (CI always does).
 */
export async function prepareMilestone(id: string, ownerEmail: string | null, changes: Record<string, unknown> = {}): Promise<{ name: string }> {
  const client = await connect(databaseUrl());
  try {
    const fields = { status: 'on_track', forecast_date: null, actual_date: null, blocker: null, comments: null, next_action: null, evidence_confidence: null, ...changes };
    const sets = Object.keys(fields).map((field, i) => `${field} = $${i + 3}`);
    const { rows } = await client.query<{ name: string }>(
      `update milestones set owner_person_id = (select person_id from people where email = $2), ${sets.join(', ')} where milestone_id = $1 returning name`,
      [id, ownerEmail, ...Object.values(fields)],
    );
    return rows[0]!;
  } finally {
    await client.end();
  }
}

export async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await connect(databaseUrl());
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Signs in an admin, setting up the authenticator app on the way (MFA is required for admins). */
export async function signInAdmin(page: Page, email: string): Promise<string> {
  await signIn(page, email);
  await page.getByRole('button', { name: 'Start set-up' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  await page.getByLabel('6-digit code').fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('account-menu')).toBeVisible();
  return secret;
}

/** Adds a person who will not sign in (decision 24), with an email so tests can find them. */
export async function createPerson(label: string): Promise<{ personId: string; name: string; email: string }> {
  const email = `e2e-${RUN}-${label}@example.com`;
  const name = `E2E person ${label}`;
  const rows = await query<{ person_id: string }>('insert into people (full_name, email) values ($1, $2) returning person_id', [name, email]);
  return { personId: rows[0]!.person_id, name, email };
}

/**
 * Approves a submission as a second programme admin, through approve_submission() exactly as the
 * approvals screen will (build step 9): signed-in claims, MFA done, row-level security on.
 */
export async function approveAsSecondAdmin(submissionId: string): Promise<void> {
  const client = await connect(databaseUrl());
  try {
    const authId = randomUUID();
    const label = `approver-${randomUUID().slice(0, 8)}`;
    const person = await client.query<{ person_id: string }>('insert into people (full_name, email) values ($1, $2) returning person_id', [`E2E ${label}`, `e2e-${RUN}-${label}@example.com`]);
    await client.query("insert into app_users (auth_user_id, person_id, email, app_role) values ($1, $2, $3, 'programme_admin')", [authId, person.rows[0]!.person_id, `e2e-${RUN}-${label}@example.com`]);
    await client.query('begin');
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: authId, role: 'authenticated', aal: 'aal2' })]);
    await client.query('set local role authenticated');
    await client.query('select approve_submission($1)', [submissionId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Loads or removes the sample RA1 structure (decision 39), each in its own transaction. */
export async function sampleData(action: 'load' | 'remove'): Promise<void> {
  const { loadSample, removeSample } = await import('../../scripts/lib/sample');
  const client = await connect(databaseUrl());
  try {
    await client.query('begin');
    await (action === 'load' ? loadSample(client) : removeSample(client));
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}
