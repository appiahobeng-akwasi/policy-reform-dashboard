# SOP: Onboarding a new user

Who does it: a programme administrator or the super_admin. Takes 5 minutes.

## Before you start

- Get the person's name and the email address they want to sign in with. Personal Gmail, Yahoo or Outlook addresses are fine.
- Agree their role with the Project Lead (see the role table in the admin guide or docs/01_SPEC.md section 3). Give the lowest role that lets them do their job.
- For reform leads and contributors, agree which reforms they work on, and whether a reform lead may approve for each one.

## Steps

1. Sign in and open **Users**, then **Add a user**.
2. Enter their full name and email, choose their role and language, and tick their reforms: *Works on*, and *Approves for* if they approve updates for that reform.
3. Select **Add a user**. Check the page says "Account added".
4. Tell the person, in their language:
   - go to the dashboard address and select "Sign in";
   - enter their email address and press the button;
   - open the email, select "Sign in", then "Sign in" again on the page that opens;
   - the link works once and expires after one hour;
   - administrators: have an authenticator app on their phone ready (Google Authenticator or Microsoft Authenticator).

No access to the app yet (a new database)? Use the command line instead:

```bash
npm run users:add -- --email name@gmail.com --name "Full Name" --role contributor --scope RA1
```

For a reform lead who approves for RA1: `--role reform_lead --scope RA1:approve`. Add `--language fr` for a French speaker.

On the hosted trial, add `ENV_FILE=.env.hosted` in front of each command so it reaches the hosted database (docs/04 section 6b).

## The sign-in email does not arrive

Ask them to check spam first, then to request a new link (one per minute at most). If the link says it has expired straight away, something opened it before them: check that the email came from the dashboard's sender, not from Supabase, and that link tracking is off in Resend. If email is still not working, make a one-time link yourself:

```bash
ENV_FILE=.env.hosted npm run users:link -- --email name@gmail.com
```

It refuses anyone not added yet. Send the link to that person only, by a private channel such as a direct message, never a group. It works once and expires after one hour.

## Someone who owns items but will not sign in

Open **Users**, then **People without accounts**, then **Add a person**. Give them an email address if they will be named as owner or reporter in bulk uploads. Their updates are entered by the Secretariat through **For someone else**. If they later need to sign in, open them and select **Give access**.

## When someone leaves

Open them under **Users** and select **Turn off account**. Nothing they did is deleted. Reassign their open items to a new owner.

## If it goes wrong

| Problem | What to do |
|---|---|
| "already in use" | The person is already listed. Search for them under **Users** or **People without accounts** and edit them there. |
| They get no email | Check the address for typing errors. Ask them to look in spam, wait one minute and ask again. |
| "This email address is not registered" | They used a different address from the one you added. Add that address, or ask them to use the listed one. |
| An administrator lost their phone | A super administrator opens them under **Users** and selects **Reset authenticator app**. They set up a new one at their next sign-in. |
| "You cannot change your own role" | Ask another administrator to make the change. |
