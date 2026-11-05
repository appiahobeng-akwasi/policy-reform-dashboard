# Contributing

Thank you for helping. Questions, bug reports and improvements are welcome as issues and pull requests. Report security problems privately instead (see [SECURITY.md](SECURITY.md)).

## Ground rules

These hold for every change. They are also in [CLAUDE.md](CLAUDE.md), which coding assistants read first.

1. **The database is the gatekeeper.** Row-level security decides who sees and changes what. Every new table gets row-level security in the same migration.
2. **No direct writes to business tables.** Every change goes submission → data quality check → approval by someone else → applied in one transaction with the audit trail set.
3. **One rule engine.** `rules/dq_rules.v1.json` is the only source of validation rules. Never hard-code a rule in a component.
4. **All schema in numbered, forward-only migrations** under `db/migrations`. `npm run db:reset` must rebuild everything from scratch.
5. **Plain Postgres** in business tables and views. Provider-specific code (sign-in, storage) stays behind the adapters in `src/lib/platform/`.
6. **French and English everywhere.** No user-facing text outside `src/i18n/en.json` and `src/i18n/fr.json`. A test fails if you add some.
7. **Low bandwidth.** Server-rendered pages, little JavaScript, no heavy charting library, 50 rows per page.
8. **Never invent data.** Unknown values stay empty and the quality check flags them. Sample data is labelled as sample.
9. **Tests ship with code.** Each rule has a passing and a failing fixture; row-level security has a test per role; the submit → check → approve → apply chain has an end-to-end test.

## Before you open a pull request

```bash
npm run typecheck && npm run lint
npm run test && npm run test:db
npm run test:e2e
```

Run `npm run db:reset` before a full end-to-end run, because test data builds up in the local database. Keep pull requests small, explain why the change is needed, and update the docs in `docs/` and `docs/manuals/` with any change people will notice.

## Writing style

Plain British English, short sentences, active voice. Name things the way users know them (milestone, evidence, review). Error messages say what is wrong and how to fix it.

By contributing you agree that your contribution is released under the [MIT licence](LICENSE).
