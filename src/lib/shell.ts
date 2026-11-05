// What the app shell (sidebar and top bar) needs for the signed-in person: which links they
// see, and the counts beside Approvals and Notices (docs/08 section 2).
import type { AuthClaims } from './auth';
import { BULK_ROLES } from './bulk/roles';
import { asUser } from './server-db';

export const APPROVER_ROLES = ['super_admin', 'programme_admin', 'reform_lead', 'merl_officer'];
// Viewers never send updates, so they have no data quality record.
const VIEWER_ROLES = ['viewer_internal', 'viewer_counterpart'];

export type Access = { internal: boolean; admin: boolean; approver: boolean; bulk: boolean; sends: boolean };

export function accessFor(role: string): Access {
  return {
    // Counterparts see Executive, Portfolio and Pathway only (spec 01 section 3, decision 59).
    internal: role !== 'viewer_counterpart',
    admin: role === 'programme_admin' || role === 'super_admin',
    approver: APPROVER_ROLES.includes(role),
    bulk: BULK_ROLES.includes(role),
    sends: !VIEWER_ROLES.includes(role),
  };
}

/** Getting started (decision 80): what this person has done so far, from their own records. */
export type GettingStarted = { sent: boolean; evidence: boolean; reviewed: boolean };
export type ShellCounts = { approvals: number; unread: number; started: GettingStarted | null };

export async function shellCounts(claims: AuthClaims, access: Access): Promise<ShellCounts> {
  return asUser(claims, async (db) => {
    // Only approvers see the approvals link, so only they pay for counting; only people who send
    // updates get the checklist. One round trip for the whole shell.
    const { rows } = await db.query<{ approvals: number; unread: number; sent: boolean | null; evidence: boolean | null; reviewed: boolean | null }>(
      `select case when $1 then (select count(*)::int from approvable_submissions()) else 0 end as approvals,
              (select count(*)::int from notification_log where person_id = (me()).person_id and channel = 'in_app' and read_at is null) as unread,
              case when $2 then exists (select 1 from submissions where submitted_by = (me()).user_id
                                         and status in ('proposed', 'approved', 'returned', 'applied')) end as sent,
              case when $2 then exists (select 1 from evidence_uploads where uploaded_by = (me()).user_id) end as evidence,
              case when $2 and $1 then exists (select 1 from submissions where reviewer = (me()).user_id) end as reviewed`,
      [access.approver, access.sends],
    );
    const row = rows[0];
    if (!row) return { approvals: 0, unread: 0, started: null };
    return {
      approvals: row.approvals,
      unread: row.unread,
      started: access.sends ? { sent: row.sent === true, evidence: row.evidence === true, reviewed: row.reviewed === true } : null,
    };
  });
}
