# Data quality gate

the product owner's design: every upload is checked against the master template; a quality score of 80 or more passes, below 80 rejects and shows where the gaps are so the user can fix and retry; the whole process is logged so the admin can track data quality and rejects per user and give targeted training. This document turns that into a buildable specification. The machine-readable rule set is `rules/dq_rules.v1.json`; the full rule table is at the end of this file.

## 1. Pass rule

A submission passes only if all three hold:

1. **File rules** (bulk upload only): all pass. A file failure stops the run before rows are read.
2. **Blocking rules: zero failures.** A single blocking failure rejects the submission, whatever the score.
3. **Quality score ≥ 80.** Configurable by super_admin per rule set version; the threshold used is stored on each run.

Why two tiers: an average alone can pass a file with one row that breaks the dashboard (39 good rows and one unknown Reform ID scores about 97), and can reject a file over trivial gaps.

## 2. Score formula

For every (row, scored rule) pair where the rule applies:

```
quality_score = 100 × Σ(weight × passed) / Σ(weight × applicable)
```

- Rounded to one decimal place. 79.95 rounds to 80.0 and passes.
- A submission with no applicable scored checks scores 100.
- Weights: 3 = matters for management decisions (next action, blocker, risk mitigation, decision follow-up, indicator evidence, overdue-but-on-track); 2 = matters for trust (forecast date, progress/status agreement, override reason, placeholders, residual risk, confidence, staleness); 1 = nice to have (evidence confidence, dependency hygiene, proxy comment, units).
- Auto-fixes (X rules: trimming spaces, normalising case) are applied, logged as severity `fixed`, and never cost score.

Worked example: 10 milestone rows, all active. Q01 (w3) passes 8 of 10, Q04 (w3) passes 10, Q05 (w2) passes 9, Q08 (w2) passes 10, Q23 (w2) passes 4.
Applicable = 10×3 + 10×3 + 10×2 + 10×2 + 10×2 = 120. Passed = 8×3 + 10×3 + 9×2 + 10×2 + 4×2 = 100. Score = 83.3. Passes if there are no blocking failures.

## 3. Same gate on all three routes

| Route | When the gate runs | What the user sees |
|---|---|---|
| Web form | Field-level as they type (instant), full run on submit | Red field messages for blocking rules; amber hints and a live score for scored rules |
| Bulk upload | On upload, again on every resubmit from the preview | Preview grid: red cells (blocking), amber cells (scored), score, list of gaps with row and column, download of the gap list |
| On behalf | Same as web form | Same, plus the on-behalf person is recorded on the run |

Because every route is scored the same way, nobody avoids the gate by switching route.

## 4. Fix and retry

- Rejected submissions are kept in staging (`submissions.status = rejected_by_gate`, payload intact). Nothing touches live tables.
- Bulk upload: the user can edit flagged cells in the preview and resubmit without re-uploading. Re-upload is also allowed.
- Each retry creates a new `dq_runs` row with `attempt_no + 1` and `previous_run_id`, so the chain is visible.
- A passing submission becomes `proposed` and goes to the approver.

## 5. Logging (what is stored per attempt)

`dq_runs`: submission, attempt number, previous run, rule set version, route, run by, on-behalf person, start time, duration, rows total, rows with blocking errors, file failures, blocking failures, weighted applicable and passed, score, threshold, outcome, reject reason.

`dq_findings`: one row per failed or fixed check: rule ID, tier, severity, entity, sheet, row, field, cell, value seen, message in English and French, weight.

`upload_batches`: original file (stored), name, SHA-256, size, template version, sheets found, uploader, on-behalf person.

## 6. Approval after the gate

Approval is a separate human step. On approve, the server re-runs B03 (references exist), B11 (scope) and B12 (period lock) against live data, because things can change between gate and approval. Then it applies the rows in one transaction with the audit context set (actor, on-behalf, submission). Four-eyes: approver ≠ submitter.

## 7. Admin data quality page

| Metric | Definition | Source |
|---|---|---|
| First-time pass rate | Passes on attempt 1 ÷ all attempt-1 runs | v_dq_user_metrics |
| Average score | Mean quality_score of runs | v_dq_user_metrics |
| Rejects | Runs with outcome reject | v_dq_user_metrics |
| Top failing rules | Error findings by rule per month, with users affected and % of active users | v_dq_rule_failures |
| Time to fix | Hours from first attempt to pass in a chain; attempts per chain | v_dq_time_to_fix |
| Trend | Monthly average score and first-time pass rate, all users and per reform | dq_runs |
| Stale items | Active items not confirmed in 30 days, by owner | v_delivery_flags |

Filters: month, route, reform, user (admin only).

## 8. Training loop

1. **Fix the system before the people.** If a rule fails for more than 30% of active users in a month, review the rule wording, the template or the form first. Log the decision.
2. **Targeted training.** If a user's first-time pass rate is under 60% over their last 5 submissions, the admin page suggests training on that user's top three failing rules, and can send a `training_suggested` notice with a short how-to (one per rule, in FR and EN, written as part of D6 and D7).
3. **Privacy.** Per-user figures are visible to the user (their own) and admins only. No league tables, no public rankings. A visible ranking pushes people to stop uploading and route everything through the Secretariat.
4. **Use in ToT (D7, D8).** The most common failing rules over the first two months become the core exercises in the Training of Trainers package.

## 9. Versioning

- Rules, weights and the threshold live in `dq_rulesets` with a version, effective date, checksum and approver. Exactly one is current.
- Every run stores the version it used, so scores from different months can be compared fairly.
- Template and rule set versions move together (template 1.0.0 ↔ rules 1.0.0). The current and previous template versions are accepted (F03).
- Changing a rule: draft new version → test against the last month of submissions (how many would have passed?) → Project Lead approves → set current. Record the change in docs/07.

## 10. What the gate cannot do

A file can score 100 and still be wrong: "on track" on a milestone that slipped. The gate checks format, completeness and internal consistency. Truth depends on the approval step, evidence validation, the staleness rule (Q23) and the overdue-but-on-track rule (Q04).

## 11. Testing requirements

For each rule: one fixture that passes and one that fails, in `tests/dq/fixtures`, with the expected finding. Plus: score formula (including the worked example above and the 79.95 rounding case), file rules on real Excel files (macro file, renamed header, formula cell, 2,001 rows), and the full chain (reject → fix → pass → approve → applied → audit row).

## 12. Full rule table (v1.0.0, draft for approval)

| ID | Tier | Weight | Applies to | Field | Check | Message (EN) |
|---|---|---|---|---|---|---|
| F01 | file |  | file |  | Extension is .xlsx or .csv. Reject .xlsm, .xls and anything with macros. | This file type is not accepted. Save it as .xlsx from the official template and upload again. |
| F02 | file |  | file |  | File size is 5 MB or less. | The file is larger than 5 MB. Split it into smaller files or remove unused sheets. |
| F03 | file |  | file | README!B2 | Template version cell equals a supported version (current and the one before). | This template version is out of date. Download the current template and copy your rows into it. |
| F04 | file |  | file |  | At least one data sheet with a known name is present (Workstreams, Deliverables, Activities, Milestones, Stage_Updates, Risks, Decisions, Actions, Indicator_Values, Evidence_Register). | No recognised data sheet was found. Do not rename the template sheets. |
| F05 | file |  | file |  | Header row of every data sheet matches the template exactly (names and order). | The column headings on sheet {sheet} were changed. Restore them from the template. |
| F06 | file |  | file |  | No formulas in data cells. Values only. | Sheet {sheet} contains formulas (for example cell {cell}). Paste values only. |
| F07 | file |  | file |  | At least one data row in total; no more than 2,000 rows per sheet. | The file has no data rows, or a sheet has more than 2,000 rows. |
| F08 | file |  | file |  | SHA-256 of the file does not match an upload already accepted in the last 90 days. | This exact file was already accepted on {date}. Nothing new to load. |
| B01 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <id> | ID present and matches the pattern for the entity (see id_patterns). Blank ID is allowed only on a new row in the web form, where the system assigns it. | Row {row}: the ID "{value}" is missing or in the wrong format. Expected something like {example}. |
| B02 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <id> | ID is unique within the submission. | Row {row}: ID {value} appears more than once in this file. |
| B03 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <parent_id> | Every parent or reference ID exists (reform_id, workstream_id, deliverable_id, milestone_id, indicator_code, linked object IDs). | Row {row}: {field} "{value}" does not exist. Check the spelling or create it first. |
| B04 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <controlled> | Every controlled field holds a value from its active list (status, RAG, stage, type, category, confidence, priority, treatment, decision type, trigger type, frequency, unit). | Row {row}: "{value}" is not an accepted value for {field}. Choose one of: {allowed}. |
| B05 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <date> | Date fields are real dates (ISO or Excel date cells, not text and not bare numbers) between 2026-01-01 and 2031-12-31. | Row {row}: {field} "{value}" is not a valid date between 2026 and 2031. |
| B06 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, action | start_date,due_date,entry_date,exit_date | Start or entry date is on or before due or exit date. | Row {row}: the start date is after the due date. |
| B07 | blocking |  | workstream, deliverable, activity, milestone, reform_stage | actual_date | Actual or exit date is not in the future. | Row {row}: the actual date {value} is in the future. |
| B08 | blocking |  | workstream, deliverable, activity, milestone, risk, action | owner | An owner is set on every active item (status not in (complete, cancelled)). Owner must be a registered person, not free text. | Row {row}: no owner. Every open item needs a named person responsible. |
| B09 | blocking |  | workstream, deliverable, activity, milestone, reform_stage | evidence | Status complete requires at least one linked evidence item (existing EV- ID or an uploaded file) and an actual or exit date. | Row {row}: marked complete with no evidence or completion date. Attach the evidence (minute, letter, report) and the date. |
| B10 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <number> | Numeric fields are numbers in range: progress_pct 0 to 100; likelihood and impact 1 to 5; readiness score 0 to 100; indicator value not negative unless the indicator allows it. | Row {row}: {field} "{value}" must be a number between {min} and {max}. |
| B11 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <reform_id> | Uploader may write to the row's reform (user_reform_scope). For on-behalf entry, the subject person must also be in scope. | Row {row}: you do not have permission to update {value}. Ask the administrator. |
| B12 | blocking |  | indicator_value | period_end | The reporting period is open. Values for a closed (locked) period cannot be changed by upload or form; use a change request. | Row {row}: the period ending {value} is closed. Submit a change request instead. |
| B13 | blocking |  | workstream, deliverable, activity, milestone | actual_date | Actual date is empty when status is not_started. | Row {row}: an item that has not started cannot have an actual completion date. |
| B14 | blocking |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <text> | Text cells contain no line of HTML or script and are 2,000 characters or fewer. | Row {row}: {field} is too long or contains code. |
| B15 | blocking |  | evidence_item | file | Evidence file: type is pdf, jpg, jpeg, png, docx or xlsx; size 10 MB or less after compression; not a duplicate (SHA-256) of an existing file. | The evidence file is the wrong type, too large, or already uploaded as {existing}. |
| B16 | blocking |  | evidence_item | links | Evidence is linked to at least one object (reform, workstream, deliverable, activity, milestone, stage, decision, risk or indicator value). | This evidence is not linked to anything. Say which milestone, decision or indicator it supports. |
| X01 | autofix |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <id>,<code> | Trim leading and trailing spaces in IDs and codes. | Row {row}: removed extra spaces in {field}. |
| X02 | autofix |  | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | <controlled> | Case-insensitive match to a list value is normalised to the canonical value (for example "In Progress" to in_progress). | Row {row}: "{value}" read as "{canonical}". |
| Q01 | scored | 3 | workstream, deliverable, activity, milestone | next_action | Next action filled on active items. | Row {row}: add the next action so the team knows what happens next. |
| Q02 | scored | 3 | workstream, deliverable, activity, milestone, reform_stage | blocker | Blocker or comment filled when status is at_risk, delayed or blocked. | Row {row}: explain what is blocking or delaying this item. |
| Q03 | scored | 2 | workstream, deliverable, activity, milestone | forecast_date | Forecast date given when status is delayed, or when due date has passed and status is not complete. | Row {row}: give a new expected date. |
| Q04 | scored | 3 | workstream, deliverable, activity, milestone | status,due_date | Status is not on_track when due date has passed and item is not complete. | Row {row}: the due date has passed but the status says on track. Update the status. |
| Q05 | scored | 2 | workstream, deliverable, activity, milestone | progress_pct | Progress agrees with status: complete is 100, not_started is 0, otherwise 1 to 99. | Row {row}: progress {value}% does not match status {status}. |
| Q06 | scored | 2 | workstream, deliverable, reform | rag_override_reason | If a manual RAG differs from the computed RAG, a reason is given. | Row {row}: you set RAG to {value}. Add the reason for overriding the calculated rating. |
| Q07 | scored | 1 | milestone, deliverable, indicator_value | evidence_confidence | Evidence confidence (high, medium, low) given. | Row {row}: rate how confident you are in the evidence. |
| Q08 | scored | 2 | workstream, deliverable, activity, milestone, reform_stage, risk, decision, action, indicator_value, evidence_item, adaptation, readiness_assessment | name,description | Names and descriptions are at least 10 characters and are not placeholders (TBC, TBD, N/A, x, test, "POC placeholder", copied header names). | Row {row}: {field} looks like a placeholder. Write what it actually is. |
| Q09 | scored | 1 | workstream, deliverable, activity, milestone | depends_on | Dependencies, when given, point to existing items and do not create a loop. | Row {row}: dependency {value} not found or creates a loop. |
| Q10 | scored | 3 | risk | mitigation,trigger,review_date | Open risks have mitigation, trigger and review date. | Row {row}: an open risk needs a mitigation, a trigger and a review date. |
| Q11 | scored | 2 | risk | residual_likelihood,residual_impact | Residual score is not higher than inherent score. | Row {row}: residual risk is higher than inherent risk. Check the scores. |
| Q12 | scored | 2 | risk | review_date | Review date for an open risk is not in the past. | Row {row}: this risk was due for review on {value}. Review it and set the next date. |
| Q13 | scored | 3 | decision | follow_up_action,follow_up_owner,follow_up_due | Open decisions have a follow-up action, owner and due date. | Row {row}: a decision needs a follow-up action, an owner and a due date. |
| Q14 | scored | 3 | indicator_value | evidence_basis | Evidence basis given for every value. | Row {row}: say where this number comes from. |
| Q15 | scored | 2 | indicator_value | confidence | Confidence level given. | Row {row}: rate your confidence in this value. |
| Q16 | scored | 1 | indicator_value | comment | Proxy values carry a comment explaining the proxy. | Row {row}: explain what the proxy measures. |
| Q17 | scored | 2 | indicator_value | comment | A change of more than 50% from the previous approved value carries a comment. | Row {row}: the value moved from {prev} to {value}. Explain the change. |
| Q18 | scored | 2 | indicator | target_type | Each target states whether it is Year 1 or life of programme. | Indicator {value}: say whether the target is Year 1 or life of programme. |
| Q19 | scored | 2 | evidence_item | source_institution,evidence_date,evidence_type | Evidence has source institution, date and type. | Add the source institution, date and type of this evidence. |
| Q20 | scored | 2 | reform_stage | escalation_to | Escalation target given when escalation_needed is true. | Row {row}: escalation is needed. Say to whom. |
| Q21 | scored | 2 | readiness_assessment | <dimensions>,assessor | All six readiness dimensions rated and assessor named. | Rate all six readiness dimensions and name the assessor. |
| Q22 | scored | 2 | adaptation | rationale,approved_by,approval_date | Approved adaptations carry rationale, approver and date. | Row {row}: an approved change needs the reason, who approved it and when. |
| Q23 | scored | 2 | workstream, deliverable, activity, milestone | last_update | Item updated within the last 30 days (staleness). Checked on the stored record at each submission and nightly. | Row {row}: not updated since {value}. Confirm it is still accurate. |
| Q24 | scored | 1 | indicator | unit | Indicators whose name starts with "Percentage" use unit %. | Indicator {value}: a percentage indicator must use the unit %. |
