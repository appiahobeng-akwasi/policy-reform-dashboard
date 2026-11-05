-- 0010: bulk upload (build step 7). The template's reported_by_email column is recorded with
-- the upload until on-behalf entry exists (build step 8, decision 29).
alter table upload_batches add column reported_by_emails text[] not null default '{}';
