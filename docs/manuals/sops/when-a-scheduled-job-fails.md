# SOP: When a scheduled job fails

Who does it: a programme administrator, with the technical lead for server problems. Takes 10 minutes.

## How you find out

- **Jobs** in the menu shows the run as *Failed*, with the error.
- The server's scheduler reports a failed command (exit code 1) or a failed web call (status 500).
- Nobody got their Monday summary, or the reminders stopped.

## Steps

1. Open **Jobs** and read the error on the failed run. Nothing the failed run did was kept, so it is safe to run again.
2. If the error mentions the database or the connection, ask the technical lead to check the server is up. Wait until it is.
3. Select **Run now** for that job. Check the new run says *Finished*.
4. If the failed run was for an earlier day (the server was down), ask the technical lead to run it for that day: `npm run jobs -- daily --date YYYY-MM-DD`. Do this for each missed day, oldest first. Nothing is sent twice.
5. If the run finished but says *emails failed*, the email service refused them. Notices still went out. Ask the technical lead to check the SMTP settings and the provider's dashboard. The next day's run sends the next day's email; the failed ones are not re-sent.
6. If it fails again with the same error, send the error text to the technical lead and note it in the issue log.

## Month end

If the month-end snapshot did not run, run it as soon as you can: **Run now** on *Month-end snapshot* freezes the month just ended. It never overwrites a snapshot already taken. The snapshot shows the figures on the day it runs, so run it before people start updating for the new month.
