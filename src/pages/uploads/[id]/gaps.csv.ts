import type { APIRoute } from 'astro';
import { t } from '../../../i18n';
import { csvCell } from '../../../lib/bulk/csv';
import { columnForField } from '../../../lib/bulk/map';
import { BULK_ROLES } from '../../../lib/bulk/roles';
import { withoutRowPrefix } from '../../../lib/gate/messages';
import { asUser } from '../../../lib/server-db';

// The list of problems from the latest check, in the person's language (docs/03 section 3).
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const id = params['id'] ?? '';
  if (!user || !BULK_ROLES.includes(user.role) || !/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 404 });
  const lang = locals.lang;
  const found = await asUser(user.claims, async (db) => {
    const { rows } = await db.query<{ sheet: string | null; row_ref: number | null; cell: string | null; field: string | null; value_seen: string | null; rule_id: string; severity: string; message_en: string; message_fr: string }>(
      `select f.sheet, f.row_ref, f.cell, f.field, f.value_seen, f.rule_id, f.severity, f.message_en, f.message_fr
         from dq_findings f
        where f.dq_run_id = (select r.dq_run_id from dq_runs r join submissions s using (submission_id)
                              where s.submission_id = $1 and s.submitted_by = (me()).user_id order by r.started_at desc, r.attempt_no desc limit 1)
          and f.severity <> 'fixed'
        order by f.sheet nulls first, f.row_ref nulls first, f.finding_id`,
      [id],
    );
    return rows;
  });
  const header = ['csv_sheet', 'csv_row', 'csv_cell', 'csv_column', 'csv_value', 'csv_rule', 'csv_severity', 'csv_message'] as const;
  const lines = [
    header.map((key) => csvCell(t(lang, `bulk.${key}`))).join(','),
    ...found.map((f) =>
      [
        f.sheet,
        f.row_ref,
        f.cell,
        f.sheet ? columnForField(f.sheet, f.field) : null,
        f.value_seen,
        f.rule_id,
        t(lang, f.severity === 'error' ? 'bulk.severity_error' : 'bulk.severity_warning'),
        withoutRowPrefix(lang === 'fr' ? f.message_fr : f.message_en),
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  // A byte-order mark so Excel opens the accents correctly.
  return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="upload-problems-${id.slice(0, 8)}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
