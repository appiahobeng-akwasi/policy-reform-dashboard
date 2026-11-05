# Data model

The schema is in `db/migrations/0001_core_schema.sql` (business tables), `0002_workflow_dq_audit.sql` (submissions, gate, audit, notifications, views) and `0003_access_control.sql` (row-level security). It is plain PostgreSQL so it can run under Supabase, a self-hosted Postgres, Directus or NocoDB. It has been loaded and tested on PostgreSQL 16 with the seed data.

## 1. Entity map

```
reforms (RA1..RA3)
 ├─ reform_stages (8 per reform: PT-001..)        pathway track
 ├─ workstreams (WS-RA1-01)                        type: policy | technical | stakeholder | implementation
 │   └─ deliverables (DL-RA1-001)
 │       ├─ activities (AC-RA1-0001)
 │       └─ milestones (MS-nnn, optional link)
 ├─ milestones (MS-nnn, scope = reform)
 ├─ readiness_assessments (RD-nnn)
 └─ indicator_reform_links → indicators (O1.1, P2.3 ...) → indicator_values (per period)

milestones (scope = programme, no reform)           e.g. diagnostic finalised, first QSR

Link tables (object_type, object_id) so one record can attach to any level:
 risk_links, decision_links, adaptation_links, evidence_links, dependencies

actions (AN-nnnn) ← from decisions, reviews, risks, escalations, adaptations
reviews → decisions, escalations
people ← app_users (sign-in), institutions
```

Valid `object_type` values: reform, workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, adaptation, indicator, indicator_value, evidence_item.

## 2. IDs

| Entity | Pattern | Example | Assigned by |
|---|---|---|---|
| Reform | `RA[0-9]` | RA1 | Fixed |
| Workstream | `WS-RA[n]-nn` | WS-RA1-02 | System (next_child_id) |
| Deliverable | `DL-RA[n]-nnn` | DL-RA1-004 | System |
| Activity | `AC-RA[n]-nnnn` | AC-RA1-0012 | System |
| Milestone | `MS-nnn` | MS-009 | System (sequence from 200; 001-020 master, 101-112 PoC imports) |
| Pathway stage record | `PT-nnn` | PT-003 | Seed / system |
| Risk | `RK-nnn` | RK-004 | System (from 200; 101-106 PoC imports) |
| Decision | `DC-nnn` | DC-005 | System (from 100) |
| Action | `AN-nnnn` | AN-0001 | System |
| Adaptation | `AD-nnn` | AD-002 | System |
| Evidence | `EV-nnn` | EV-007 | System (from 100) |
| Readiness | `RD-nnn` | RD-001 | System |
| Indicator | `[O or P][n].[n]` | O1.2 | Logframe |

IDs are never reused and never edited. Archiving uses `archived_at`.

## 3. Common fields on delivery objects

owner_person_id, start_date, due_date (planned_date on milestones), forecast_date, actual_date, status, progress_pct, next_action, blocker, comments, rag_override + rag_override_reason, created_at, updated_at, updated_by, last_confirmed_at, archived_at. Dependencies, evidence, risks and decisions attach through link tables.

## 4. Controlled vocabularies

| List | Values |
|---|---|
| Delivery status | not_started, on_track, at_risk, delayed, blocked, complete, cancelled |
| Stage status | not_started, in_progress, complete, blocked |
| Pathway stage | problem_identified, reform_agreed, technical_design, consultation, validation, approval, implementation, institutionalised |
| RAG | green, amber, red, grey (not started / no data), blue (complete) |
| Workstream type | policy, technical, stakeholder, implementation |
| Milestone type | legal, technical, consultation, approval, operational |
| Risk category | political, institutional, legal, financial, operational, data, security, stakeholder, climate, plus political_economy, delivery_capacity, regulatory from the PoC (to confirm or merge) |
| Risk status | open, monitoring, closed |
| Treatment | treat, transfer, tolerate, terminate |
| Decision type | continue, adapt, escalate, pause, stop, resequence |
| Decision status | open, implemented, closed, cancelled |
| Evidence type | meeting_minutes, letter, draft_law, circular, memo, report, screenshot, email, signed_agreement, other |
| Validation status | pending, validated, rejected |
| Confidence | high, medium, low |
| Trigger type (adaptation) | delay, political_change, new_opportunity, risk_escalation, evidence_change, other |
| Governance tier | 1 informed, 2 reviews/endorses, 3 approves |
| Access level | internal, restricted, external, public |

Labels in English and French live in `lookup_values`. Mapping applied to source data: "Done"/"Completed" → complete; "In Progress" → in_progress (stage) or on_track (milestone); "Verified" → validated (but loaded as pending until a file exists).

## 5. Calculated values (never typed)

- **RAG** (`computed_rag`): blue if complete; grey if cancelled or not started before its start date; red if blocked, more than 14 days overdue, or not started 14+ days after its start date; amber if at risk or delayed, 1 to 14 days overdue, or due within 7 days with progress under 50%; otherwise green. Manual override allowed only with a reason (rule Q06). Thresholds to confirm with the project lead.
- **Reform RAG**: red if any item under it is red, amber if any amber, grey if no items, else green; or override with reason.
- **Days overdue, days to due, days since update, is_stale (> 30 days)**: `v_delivery_flags`.
- **Risk scores**: inherent = likelihood × impact; residual = residual likelihood × residual impact (generated columns). High = 15 or more.
- **Readiness score**: the source scores (72, 68, 64) cannot be traced to the ratings. Proposed method v1, to agree with the project lead: High = 3, Medium = 2, Low = 1; score = sum of six ratings ÷ 18 × 100, rounded. Store `overall_score_computed` and `method_version`; show the source score only as history.
- **Progress %** at reform level: do not show a single percentage until a method is agreed (the source used the readiness score as progress). Show counts by status instead.
- **Indicator variance**: latest approved value minus Year 1 target, shown only when the target is numeric.

## 6. Indicators and targets

- Year 1 targets come from the logframe sheet (confirmed in source). Larger targets in MERL_Indicators look like life-of-programme targets; they are stored as `target_lop` with `target_lop_confirmed = false` until the MERL lead confirms.
- `programme_area`: pillar_1 (O1.x, P1.x), pillar_2_3 (O2.x, O3.x, P2.x), cross_cutting (P4.x GEDSI, P5.x PECA).
- Values are per indicator, per reform (or programme total when reform is null), per period end, per snapshot type. Values in a locked reporting period cannot be changed except by a change request (rule B12).
- Proxy values are allowed but flagged (`is_proxy`) and need a comment (Q16).

## 7. Evidence

- One evidence record per document; link it to as many objects as it supports. The source had the same document entered up to three times; the seed merges them.
- File stored in object storage under `evidence/{yyyy}/{sha256}.{ext}` (decision 25: named by fingerprint, because the evidence ID is assigned at approval, after the upload). The hash prevents duplicates.
- Access level defaults to restricted. Only external or public evidence is visible to government viewers.
- No file → validation_status stays pending, whatever the source said.

## 8. Snapshots

At each month end and quarter end a job freezes one row per reform in `reform_status_snapshots` from `v_reform_summary`. Trend charts read snapshots, not live data. Source snapshots from July and August 2026 are kept for history only; the August rows contradict the pathway tracker and must not be displayed as fact.

The month-end job (`job_month_end`, migration 0015) writes these rows and never overwrites one. Every scheduled run is logged in `job_runs`. Reminders are rows in `notification_log` with the day the job raised them (`for_date`) and their details (`detail`); emails sent are logged there too, as `email_sent`.

Review packs (migration 0016) are saved in `review_packs`: the facts given to one review meeting, as a numbered version that cannot be changed. They are a record, not business data; the `reviews` table (the meeting calendar) is filled once the reporting calendar is agreed (open question 20).
