import { describe, expect, it } from 'vitest';
import { describeDatabase, isLocalDatabase, sqlFiles } from '../../scripts/lib/db';

describe('isLocalDatabase()', () => {
  it.each([
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'postgresql://postgres:postgres@localhost:5432/postgres',
    'postgresql://postgres:postgres@[::1]:5432/postgres',
  ])('treats %s as local', (url) => {
    expect(isLocalDatabase(url)).toBe(true);
  });

  it.each([
    'postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres',
    'postgresql://user:secret@10.0.0.5:5432/ggp',
    'postgresql://user:secret@localhost.evil.example:5432/ggp',
  ])('treats %s as remote, so db:reset refuses it', (url) => {
    expect(isLocalDatabase(url)).toBe(false);
  });
});

describe('describeDatabase()', () => {
  it('never shows the password', () => {
    expect(describeDatabase('postgresql://postgres:secret@db.example.org:6543/postgres')).toBe('db.example.org:6543/postgres');
  });
});

describe('sqlFiles()', () => {
  it('lists migrations in order, then the seed', () => {
    expect(sqlFiles().map((f) => `${f.kind}:${f.name}`)).toEqual([
      'migration:0001_core_schema.sql',
      'migration:0002_workflow_dq_audit.sql',
      'migration:0003_access_control.sql',
      'migration:0004_view_and_access_fixes.sql',
      'migration:0005_approval_workflow.sql',
      'migration:0006_pathway_stage_labels.sql',
      'migration:0007_sign_in_and_preferences.sql',
      'migration:0008_payload_evidence_and_dependencies.sql',
      'migration:0009_item_versions_and_uploads.sql',
      'migration:0010_upload_batch_reporters.sql',
      'migration:0011_on_behalf_entry.sql',
      'migration:0012_approvals_and_notices.sql',
      'migration:0013_views_and_sample_flag.sql',
      'migration:0014_users_admin_and_dq_page.sql',
      'migration:0015_scheduled_jobs.sql',
      'migration:0016_review_packs.sql',
      'migration:0017_readiness_score.sql',
      'migration:0018_rate_limits_and_error_log.sql',
      'migration:0019_policies_check_once_per_query.sql',
      'migration:0020_item_activity.sql',
      'migration:0021_security_review_fixes.sql',
      'migration:0022_email_retries.sql',
      'seed:0100_demo_seed.sql',
    ]);
  });
});
