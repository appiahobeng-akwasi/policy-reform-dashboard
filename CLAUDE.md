# CLAUDE.md: GGP Pillar 1 Policy Reform Dashboard

Read this file first, then `docs/02_DATA_MODEL.md`, `docs/03_DATA_QUALITY_GATE.md` and `docs/04_ARCHITECTURE_AND_HOSTING.md` before writing code.

## What this is

A reform-delivery management system for government reform programmes, first built for Pillar 1 (policy and institutional reform) of the Green Growth Programme in the Democratic Republic of the Congo. It tracks reforms down the chain Reform → Workstream → Deliverable → Activity → Milestone, with risks, decisions, evidence, MERL indicators and the governance cycle (Prepare, Review, Decide, Track). The data in `db/seed` is fictional demo data.

## Non-negotiables

1. **The database is the gatekeeper.** Row-level security decides who sees and changes what. The UI only hides buttons. Every new table gets RLS in the same migration.
2. **No direct writes to business tables from users.** Every change goes: submission → data quality gate → approval → `apply_submission()` in one transaction with audit context set. Only super_admin may bypass, and that is logged.
3. **One rule engine.** `rules/dq_rules.v1.json` is the single source of truth for validation. The server run is authoritative; the client uses the same engine for hints. Never hard-code a rule in a component.
4. **Pass = zero blocking failures AND quality score ≥ threshold (80).** Score formula and rounding exactly as in `docs/03_DATA_QUALITY_GATE.md` section 2. Store the threshold and rule set version on every run.
5. **Log every gate attempt** (dq_runs, dq_findings, upload_batches) including rejects and retries. Per-user data quality is visible only to that user and admins.
6. **All schema in migrations** under `db/migrations`, numbered, forward-only. Never change the schema in a hosted console. `npm run db:reset` must rebuild from scratch and load `db/seed`.
7. **Plain Postgres.** Do not use vendor-only features in business tables or views, so the schema can move to Directus, NocoDB or self-hosting. Supabase-specific code (auth, storage clients) stays behind small adapters in `src/lib/platform/`.
8. **French and English everywhere.** No user-facing string outside the i18n catalogues (`src/i18n/fr.json`, `src/i18n/en.json`). Each user switches between EN and FR with a toggle in the header; the choice is saved to their profile (`people.preferred_language`). First visit follows the browser language, falling back to English. Every gate message exists in both languages (already in the rules JSON).
9. **Low bandwidth.** Server-render views; React islands only where interaction needs it; first load ≤ 300 KB JS compressed; no heavy charting library (hand-written SVG); paginate at 50; compress images in the browser before upload; resumable uploads over 2 MB; save form drafts to IndexedDB.
10. **RAG is computed** (`computed_rag` in 0002). A manual override needs a reason. Never let a user type a RAG without one.
11. **Never invent data.** If a value is unknown, leave it empty and let the gate flag it. Sample data for demos must be labelled as sample in the UI.
12. **Tests ship with code.** Every rule: one passing and one failing fixture. RLS: a test per role. The submit → gate → approve → apply chain: an end-to-end test. CI must pass before merge.

## Hosting

Keep everything portable: configuration through environment variables, no host-specific code outside `src/lib/platform/`, and a documented way to move the database and files to another host.

## Stack (prototype)

Supabase (Postgres 15+, Auth with Google and magic link, Storage), Astro with SSR + React islands, TypeScript strict, plain CSS with tokens, SheetJS for Excel on the server, Vitest, Playwright, GitHub Actions. Email via a transactional provider. Cron for reminders (daily 06:00 UTC), digest (Monday 06:00 UTC = 07:00 Kinshasa), month-end snapshot, nightly staleness.

Auth: PKCE flow only. After sign-in call `is_allowed_email()`; sign out and show a clear message if false. Enforce TOTP for super_admin and programme_admin.

## Layout

```
db/migrations/        0001 core, 0002 workflow/dq/audit/views, 0003 RLS, 0004+ yours
db/seed/              0100 fictional demo seed (replace with your own data: docs/ADOPTING.md)
rules/                dq_rules.v1.json (rule set 1.0.0)
templates/            Bulk_Upload_Template_v1.0.0.xlsx + template_manifest.v1.json
docs/                 02 data model, 03 gate, 04 architecture, 08 design system, ADOPTING
docs/manuals/         user guide, admin guide, SOPs (update with every feature)
src/                  app code
tests/                unit, db (incl. row-level security), e2e, dq/fixtures
```

## Things that are easy to get wrong

- Programme-wide milestones have `scope = 'programme'` and no reform_id. Views must show them separately, not under RA1.
- One evidence item links to many objects through `evidence_links`. Do not duplicate evidence per reform.
- One decision links to many reforms through `decision_links`. Count decisions by `decision_id`, not by link rows.
- Seeded evidence is `pending` because no files exist yet.
- The demo data is stale (last confirmed 29 Jul 2026) and shows red. That is correct; do not "fix" it in code.
- `target_lop` values are unconfirmed. Show Year 1 targets; show life-of-programme only when `target_lop_confirmed`.
- The approver must not be the submitter.
- Re-run B03, B11 and B12 at approval time, not only at the gate.
- Kinshasa is UTC+1. Store UTC; display local.
- Personal Gmail addresses are expected. Do not restrict sign-in by domain.
- Restricted data: evidence served by short-lived signed URLs only.

## Design

All UI must follow `docs/08_DESIGN_SYSTEM.md` (tokens, layout, page pattern, components). Where it conflicts with a non-negotiable above (bandwidth, accessibility, French and English), the non-negotiable wins.

## Writing style for UI copy and docs

Plain British English, short sentences, active voice. No em dashes. Name things the way users know them (milestone, evidence, review), not system terms. Error messages say what is wrong and how to fix it.
