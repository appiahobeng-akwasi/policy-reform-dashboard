// A clearly labelled sample RA1 structure for the demo, used only if the real one has not
// arrived (decision 39; build plan section 2: "Do not invent real-looking data"). Everything is
// flagged is_sample, named as a placeholder, and shown as "Sample" on every screen. Dates are
// set relative to today so the views show a realistic mix of on track, at risk and overdue.
// This is demo tooling run by an administrator, like the seed: it writes directly, and the audit
// log records it.
import type pg from 'pg';

type Item = Record<string, unknown>;

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kinshasa' }).format(d);
};

function plan(owners: [string, string, string]) {
  const [a, b, c] = owners;
  const workstreams: Item[] = [
    { workstream_id: 'WS-RA1-01', reform_id: 'RA1', name: 'Sample workstream A (placeholder)', workstream_type: 'policy', owner_person_id: a, start_date: day(-60), due_date: day(120), status: 'on_track', progress_pct: 30, next_action: 'Sample next action for workstream A' },
    { workstream_id: 'WS-RA1-02', reform_id: 'RA1', name: 'Sample workstream B (placeholder)', workstream_type: 'technical', owner_person_id: b, start_date: day(-30), due_date: day(150), status: 'at_risk', progress_pct: 20, blocker: 'Sample blocker', next_action: 'Sample next action for workstream B' },
  ];
  const deliverables: Item[] = [
    { deliverable_id: 'DL-RA1-001', workstream_id: 'WS-RA1-01', name: 'Sample deliverable A1', owner_person_id: a, start_date: day(-50), due_date: day(30), status: 'on_track', progress_pct: 40, next_action: 'Sample next action for A1' },
    { deliverable_id: 'DL-RA1-002', workstream_id: 'WS-RA1-01', name: 'Sample deliverable A2', owner_person_id: c, start_date: day(-40), due_date: day(-10), forecast_date: day(20), status: 'delayed', progress_pct: 60, blocker: 'Sample blocker', next_action: 'Sample next action for A2' },
    { deliverable_id: 'DL-RA1-003', workstream_id: 'WS-RA1-02', name: 'Sample deliverable B1', owner_person_id: b, start_date: day(10), due_date: day(60), status: 'not_started', progress_pct: 0, next_action: 'Sample next action for B1' },
    { deliverable_id: 'DL-RA1-004', workstream_id: 'WS-RA1-02', name: 'Sample deliverable B2', owner_person_id: c, start_date: day(-20), due_date: day(90), status: 'on_track', progress_pct: 10, next_action: 'Sample next action for B2' },
  ];
  const activities: Item[] = deliverables.flatMap((d, i) =>
    [1, 2].map((n) => ({
      activity_id: `AC-RA1-${String(i * 2 + n).padStart(4, '0')}`,
      deliverable_id: d['deliverable_id'],
      name: `Sample activity ${String(d['name']).slice(-2)}.${n}`,
      owner_person_id: d['owner_person_id'],
      start_date: d['start_date'],
      due_date: day(Number(i * 15 + n * 5)),
      status: n === 1 ? 'on_track' : 'not_started',
      progress_pct: n === 1 ? 50 : 0,
      next_action: `Sample next action for activity ${String(d['name']).slice(-2)}.${n}`,
    })),
  );
  const milestones: Item[] = [
    { milestone_id: 'MS-901', scope: 'reform', reform_id: 'RA1', deliverable_id: 'DL-RA1-001', name: 'Sample milestone A1', owner_person_id: a, planned_date: day(25), status: 'on_track', next_action: 'Sample next action for milestone A1' },
    { milestone_id: 'MS-902', scope: 'reform', reform_id: 'RA1', deliverable_id: 'DL-RA1-002', name: 'Sample milestone A2', owner_person_id: c, planned_date: day(-5), forecast_date: day(15), status: 'delayed', blocker: 'Sample blocker', next_action: 'Sample next action for milestone A2' },
    { milestone_id: 'MS-903', scope: 'reform', reform_id: 'RA1', deliverable_id: 'DL-RA1-003', name: 'Sample milestone B1', owner_person_id: b, planned_date: day(55), status: 'not_started', next_action: 'Sample next action for milestone B1' },
    { milestone_id: 'MS-904', scope: 'reform', reform_id: 'RA1', deliverable_id: 'DL-RA1-004', name: 'Sample milestone B2', owner_person_id: c, planned_date: day(85), status: 'on_track', next_action: 'Sample next action for milestone B2' },
  ];
  return { workstreams, deliverables, activities, milestones };
}

async function insertAll(client: pg.ClientBase, table: string, rows: Item[]): Promise<void> {
  for (const row of rows) {
    const record = { ...row, is_sample: true, last_confirmed_at: new Date().toISOString() };
    const columns = Object.keys(record);
    await client.query(
      `insert into ${table} (${columns.join(', ')}) select ${columns.join(', ')} from jsonb_populate_record(null::${table}, $1)`,
      [JSON.stringify(record)],
    );
  }
}

export const SAMPLE_IDS = {
  workstreams: ['WS-RA1-01', 'WS-RA1-02'],
  deliverables: ['DL-RA1-001', 'DL-RA1-002', 'DL-RA1-003', 'DL-RA1-004'],
  milestones: ['MS-901', 'MS-902', 'MS-903', 'MS-904'],
};

/** Loads the sample structure. Refuses if any of its IDs is already used by real data. Call inside a transaction. */
export async function loadSample(client: pg.ClientBase): Promise<{ items: number }> {
  const clash = await client.query<{ id: string }>(
    `select workstream_id as id from workstreams where workstream_id = any ($1)
     union select deliverable_id from deliverables where deliverable_id = any ($2)
     union select milestone_id from milestones where milestone_id = any ($3)`,
    [SAMPLE_IDS.workstreams, SAMPLE_IDS.deliverables, SAMPLE_IDS.milestones],
  );
  if (clash.rowCount) throw new Error(`These IDs already exist: ${clash.rows.map((r) => r.id).join(', ')}. Remove the sample first, or the real structure is already loaded.`);
  const owners: string[] = [];
  for (const letter of ['A', 'B', 'C']) {
    const { rows } = await client.query<{ person_id: string }>("insert into people (full_name, is_sample, preferred_language) values ($1, true, 'en') returning person_id", [`Sample owner ${letter}`]);
    owners.push(rows[0]!.person_id);
  }
  const p = plan(owners as [string, string, string]);
  await insertAll(client, 'workstreams', p.workstreams);
  await insertAll(client, 'deliverables', p.deliverables);
  await insertAll(client, 'activities', p.activities);
  await insertAll(client, 'milestones', p.milestones);
  return { items: p.workstreams.length + p.deliverables.length + p.activities.length + p.milestones.length };
}

/** Removes every sample record, and links to them. Real data is not touched. Call inside a transaction. */
export async function removeSample(client: pg.ClientBase): Promise<{ items: number }> {
  const ids = await client.query<{ type: string; id: string }>(
    `select 'workstream' as type, workstream_id as id from workstreams where is_sample
     union all select 'deliverable', deliverable_id from deliverables where is_sample
     union all select 'activity', activity_id from activities where is_sample
     union all select 'milestone', milestone_id from milestones where is_sample`,
  );
  const types = ids.rows.map((r) => r.type);
  const objects = ids.rows.map((r) => r.id);
  for (const table of ['evidence_links', 'risk_links', 'decision_links', 'adaptation_links']) {
    await client.query(`delete from ${table} l using unnest($1::text[], $2::text[]) as x(t, i) where l.object_type = x.t and l.object_id = x.i`, [types, objects]);
  }
  await client.query(
    `delete from dependencies d using unnest($1::text[], $2::text[]) as x(t, i)
      where (d.from_type = x.t and d.from_id = x.i) or (d.to_type = x.t and d.to_id = x.i)`,
    [types, objects],
  );
  await client.query('delete from milestones where is_sample');
  await client.query('delete from activities where is_sample');
  await client.query('delete from deliverables where is_sample');
  await client.query('delete from workstreams where is_sample');
  await client.query(
    `delete from people p where p.is_sample
        and not exists (select 1 from app_users u where u.person_id = p.person_id)
        and not exists (select 1 from milestones m where m.owner_person_id = p.person_id)
        and not exists (select 1 from workstreams w where w.owner_person_id = p.person_id)
        and not exists (select 1 from deliverables d where d.owner_person_id = p.person_id)
        and not exists (select 1 from activities a where a.owner_person_id = p.person_id)`,
  );
  return { items: ids.rowCount ?? 0 };
}
