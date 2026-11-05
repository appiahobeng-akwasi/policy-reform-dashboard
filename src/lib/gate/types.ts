// Types for the data quality gate. The gate engine is plain TypeScript with no database or
// server code, so the web form can run it in the browser for hints; the server run decides.

export type Route = 'web_form' | 'bulk_upload' | 'on_behalf';
export type Tier = 'file' | 'blocking' | 'scored' | 'autofix';

export type EntityName =
  | 'workstream'
  | 'deliverable'
  | 'activity'
  | 'milestone'
  | 'reform_stage'
  | 'risk'
  | 'decision'
  | 'action'
  | 'indicator_value'
  | 'evidence_item'
  | 'adaptation'
  | 'readiness_assessment'
  | 'indicator'
  | 'reform';

/** One row of a submission, in the payload format of migrations 0005 and 0008. */
export type GateRow = {
  entity: string;
  op: 'create' | 'update';
  id?: string | null;
  fields?: Record<string, unknown>;
  links?: { object_type: string; object_id: string }[];
  evidence_ids?: string[];
  depends_on?: string[];
  /** Bulk upload by the Secretariat: the person this row was reported by (decision 33). */
  on_behalf_of_person_id?: string;
  /** For updates: the item's updated_at when the form was opened; approval refuses if it changed (W10). */
  base_updated_at?: string;
  /** Bulk upload: the row's cells as typed in the template, for the preview and fixes (ignored by the gate and approval). */
  source?: Record<string, string | number | boolean | null>;
  /** Bulk upload: template columns that had a value but are not used (decision 29). */
  ignored?: string[];
  /** For a new evidence row: the checked upload it came from (the gate and approval ignore it). */
  upload_id?: string;
  /** Where the row came from in an upload, for messages and findings. */
  ref?: { sheet?: string; row?: number };
};

/** What the server read from an uploaded workbook, for the file rules (F01 to F08). */
export type WorkbookInfo = {
  fileName: string;
  bytes: number;
  sha256: string;
  hasMacros: boolean;
  /** False if the server refused to open it (not a real workbook, or unsafe to unpack); F01 then fails. */
  readable?: boolean;
  /** README!B2, or null if missing. */
  templateVersion: string | null;
  sheets: { name: string; headers: string[]; dataRows: number; formulaCells: string[] }[];
};

export type GateInput = {
  route: Route;
  rows: GateRow[];
  workbook?: WorkbookInfo;
};

/**
 * Live data the checks need. The server fills every part; the browser may leave parts out,
 * and checks that need a missing part are skipped (hints only).
 */
export type GateContext = {
  /** Today's date in Kinshasa, YYYY-MM-DD. */
  today: string;
  /** 'gate' for submissions; 'stored' for checks on stored records (nightly, data quality page). */
  mode: 'gate' | 'stored';
  /** Active controlled lists: list name → codes. */
  lists: Record<string, readonly string[]>;
  /** "type:id" keys known to exist (only the ones the submission refers to). */
  existing?: readonly string[];
  /** Stored records for rows that update an existing item: "entity:id" → record. */
  stored?: Record<string, Record<string, unknown>>;
  /** "entity:id" keys of stored items that already have evidence linked. */
  evidenceLinked?: readonly string[];
  /** Evidence IDs that are already linked to something. */
  evidenceWithLinks?: readonly string[];
  /** Per row (same order as the input): may the submitter, and the person entered for, write it (B11)? */
  rowScope?: readonly boolean[];
  /** Per row: the reforms it touches, for messages. */
  rowReforms?: readonly (readonly string[])[];
  /** Locked reporting periods, YYYY-MM-DD. */
  lockedPeriods?: readonly string[];
  /** Previous approved indicator value: "code|reform or empty|period_end" → value. */
  previousValues?: Record<string, number>;
  /** Evidence file fingerprints already stored: sha256 → evidence ID. */
  evidenceFiles?: Record<string, string>;
  /** Upload fingerprints accepted in the last 90 days: sha256 → date. */
  acceptedUploads?: Record<string, string>;
  /** Stored dependencies as ["type:id", "type:id"] (from waits for to). */
  dependencies?: readonly (readonly [string, string])[];
  /** Template versions accepted (current and the one before). */
  supportedTemplateVersions?: readonly string[];
};

export type Severity = 'error' | 'warning' | 'fixed';

export type Finding = {
  ruleId: string;
  tier: Tier;
  severity: Severity;
  entity: string | null;
  sheet: string | null;
  rowRef: number | null;
  field: string | null;
  cell: string | null;
  valueSeen: string | null;
  messageEn: string;
  messageFr: string;
  weight: number | null;
};

export type RuleStats = { applicable: number; passed: number };

export type GateResult = {
  rulesetVersion: string;
  threshold: number;
  outcome: 'pass' | 'reject';
  rejectReason: 'file_rules' | 'blocking_rules' | 'score_below_threshold' | 'blocking_and_score' | null;
  /** 0.0 to 100.0, one decimal; null when file rules stopped the run. */
  qualityScore: number | null;
  fileFailures: number;
  blockingFailures: number;
  rowsTotal: number;
  rowsWithBlocking: number;
  /** Weighted sums over every applicable (row, scored rule) pair. */
  scoredApplicable: number;
  scoredPassed: number;
  /** Per scored rule: weighted applicable and passed (for hints and the data quality page). */
  ruleStats: Record<string, RuleStats>;
  /** Per rule: how many checks ran (not skipped as "does not apply" or for missing live data). */
  checksRun: Record<string, number>;
  findings: Finding[];
  /** The rows after auto-fixes. These are what gets saved and applied. */
  rows: GateRow[];
};
