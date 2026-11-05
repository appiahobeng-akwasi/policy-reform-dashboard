-- 0022: emails that failed are tried again, and a job whose emails partly failed says so
-- (decision 92, review of 4 Nov 2026). Forward-only.
--
--   notification_log.attempts  how many times this email was tried (a failed one is claimed
--                              again on the next run, up to three tries in all)
--   job_runs.status 'partial'  the job's own work finished but some emails were not sent

alter table notification_log add column attempts int not null default 1 check (attempts between 1 and 10);

alter table job_runs drop constraint job_runs_status_check;
alter table job_runs add constraint job_runs_status_check check (status in ('running', 'succeeded', 'partial', 'failed', 'skipped'));
