# User guide

Status: draft, updated with every feature. Prototype stage.

## Signing in

You sign in with a link sent to your email address. There is no password.

1. Go to the dashboard. The sign-in page shows the Green Growth Programme panel on the left and the form on the right (on a phone, the panel sits above the form). Switch between English and French with **EN** and **FR** at the top.
2. Enter your email address and select **Send me a sign-in link**. Any email service works: Gmail, Yahoo, Outlook or a work address.
3. Open the email "Your sign-in link" and select **Sign in**. You can open it on your phone even if you asked on a laptop.
4. On the page that opens, select **Sign in** again.

The link works once and expires after one hour. If it has expired, ask for a new one. If no email arrives within five minutes, look in your spam folder.

Only people the programme administrator has added can sign in. If the page says your address is not registered, ask the administrator to add you, or use the address they added.

To sign out, select **Sign out** at the top of the page.

## Administrators: the second step (MFA)

If you are a programme administrator or super administrator, you also need an authenticator app on your phone, for example Google Authenticator or Microsoft Authenticator.

- **First sign-in:** select **Start set-up**, scan the code with the app (or type in the key shown), then enter the 6-digit code the app shows.
- **Every sign-in after that:** enter the newest 6-digit code from the app.

Until you finish this step you cannot see any data. If a code is refused, wait for the next one (codes change every 30 seconds) and check that your phone sets its time automatically. Lost your phone? Ask a super administrator to reset your authenticator app; you set up a new one at your next sign-in.

## The six views

When you sign in you land on the **Executive** view. The green card at the top shows every open item in the programme as a ring: overdue, not confirmed for over 30 days, and neither overdue nor stale, each counted once. Items in that last group can still be rated amber or red, with the reform that has the most overdue items named. Then one card per reform with its rating, how many items are overdue, its pathway as a track of eight steps, a bar of its items' ratings, and how many are due in the next 30 days, stale, open high risks and decisions pending. Below are the programme-wide milestones with their due bars, the monthly quality score as a chart with this month's score in a ring, and escalations at levels 3 and 4. The box at the top says when an item was last confirmed and how many items have not been confirmed for over 30 days. Each view dates its own data in the same place: Risks by the last change to an open risk, MERL by the latest approved indicator value, Governance by the last change to a decision or adaptation, and Portfolio by the last readiness assessment. If more than one stage of a reform is in progress, its card names them all.

**Pathway** answers "where is each reform in its journey?".
- At the top, **All reforms** shows every reform against the eight stages: a filled dot is complete, a ringed dot is in progress, a hollow dot has not started, and a small warning sign means escalation is flagged. The line turns green as far as the reform has got.
- Below, each reform has its own row of numbered steps, with dates under each one. The stages in progress get a small card (since when, who is responsible, validation and evidence), and a line names the next stage that needs escalation.
- Select any dot, step or card to open that stage on the right: its place on the pathway, dates, who is responsible, validation, evidence and escalation. Close it with the cross or Esc. When a panel opens, the keyboard focus moves to its title, and Tab moves through the panel only until you close it.
- **Workstreams, deliverables, activities and milestones** lists each reform's items in one table: ID, item, owner, due date (with how many days late) and rating. Overdue items come first. The first five show; select **Show more** for the rest. Workstreams and deliverables open and close like folders.
- Pick a reform with the buttons at the top (**All**, **RA1**, **RA2**, **RA3**). Filter by rating, status or owner and select **Apply**. Programme-wide milestones have their own section at the bottom.

On a phone, the overview shows each reform's place in words, and the steps run down the screen.

Ratings always carry their name, not colour alone: blue complete, green on track, amber at risk, red off track or stale, grey not started. Items marked **Sample** are placeholders for the demo, not real programme data.

**Portfolio** answers "which reform is ready?". It shows each reform's readiness score in a ring, then its ratings on six dimensions, where each reform is on its pathway, how many reforms sit at each stage, and items that wait for an item in another reform. The readiness score uses a proposed method that is not yet agreed; the page says so.

**Risks** opens with four tiles: open risks that are high (15 and over), medium (8 to 14) and low (under 8), and reviews overdue. Select **Reviews overdue** to list only those. Below are three tabs:
- **Register**: one row per risk with its ID, category and reforms, the score as inherent → residual, the owner and the review date (overdue in red). Select a risk to open it on the right with its likelihood and impact, trigger, mitigation, owner and review date.
- **Heatmap**: one 5 by 5 heatmap at a time; switch between **Inherent risk** and **Residual risk**. Likelihood rises upwards, impact to the right. Select a square to list its risks in the register.
- **Bottlenecks**: items that are blocked or overdue, by owner and by institution. **Show the numbers** opens the exact table.

**MERL** opens with four tiles: how many indicators there are, how many have an approved number, how many have reached their Year 1 target (where progress can be worked out) and how many are waiting for a number. An indicator whose latest approved record has no number (for example a note only) counts as waiting, and the tile says how many there are. Choose a reform to see its own values instead of the programme totals. Below are three tabs:
- **Indicators**: grouped as outcome and output. Each row has the code, the indicator, its Year 1 target, the latest approved value with its date, confidence and proxy flag, and a progress bar towards the Year 1 target (only when the baseline, the target and the value are all numbers). Select an indicator to see its baseline, the life-of-programme target (shown once confirmed), the evidence and the trend.
- **Breakdowns**: gender, inclusion, labour market and climate-smart agriculture adoption by province, as ranges on a line. **Show the numbers** opens the exact table with its sources.
- **Learning log**: one row per lesson with its owner and next action date. Select one to read what it means.

**Governance** opens with four tiles: open decisions, follow-ups overdue, adaptations approved and the next review. Below are five tabs:
- **Decisions**: one row per decision with its type, date and reforms, who decided, and when the follow-up is due (overdue in red). Select a decision to read why it was taken, the tier, the follow-up and its owner. Choose a decision status and select **Apply** to see implemented, closed or cancelled ones.
- **Follow-up actions**: what was agreed, who owns it and when it is due.
- **Adaptations**: what triggered each change and what was asked for, with its status. Select one to see the original plan, the decision and why.
- **Who does what**: for one reform at a time (choose it with the buttons), who is responsible, accountable, consulted and informed for each activity, with its forum and gate.
- **Reviews**: the review calendar and the latest review packs.

Government counterparts see Executive, Portfolio (stages only) and Pathway for their own reform, without risks, decisions, readiness or indicators.

**Finding your way.** The menu on the left has your **Work** (My items, Approvals, Bulk upload, Reviews), the six **Views**, and for administrators **Admin**. A red number beside Approvals says how many updates wait for you.

The bar at the top has search, the language switch (EN | FR), the bell for **Notices**, **+** for everything you can start (update an item, upload a workbook, and so on), **?** for help and keyboard shortcuts, and your initials for **My account**, **My data quality** and **Sign out**.

While you are new, a **Getting started** card at the top of the menu shows your next step: send your first update or confirmation, attach your first evidence, and, if you approve updates, review your first one. It goes away when you have done them.

On a phone, the bar at the bottom of the screen has My items, Approvals (if you approve updates), Views, and **Menu** for everything else.

**Search** is at the top of every page: type an ID such as MS-104 or part of a name. Press Ctrl + K (Cmd + K on a Mac) or / to jump to it.

## My items

Select **My items** in the menu. It lists the open items you are responsible for: overdue items first, then items not confirmed for over 30 days, then by due date. A label shows if an update is waiting for approval, or has been returned to you.

The green card at the top shows your items as a ring: overdue (coral), not confirmed for over 30 days (yellow), waiting for approval (blue) and up to date (green). Each item is counted once. The number in the middle is how many need you now (overdue or not confirmed), and the sentence beside it says where to start.

Each row starts with the reform's icon: orange for RA1 land governance, blue for RA2 agricultural finance, green for RA3 value chains, grey for programme-wide items. Under the due date, a bar shows how late an item is (coral) or how much time is left (green). A full bar means 90 days or more; the text below gives the exact number.

The four boxes at the top count your items that are overdue, due in the next 30 days, stale, and waiting for approval. Select a box to show only those items; select it again, or **Clear filter**, to show them all.

Select an item to open it in a panel on the right, without leaving the list. A coloured line at the top says if it needs something (overdue, not confirmed, returned to you, or waiting for approval). Below it are the due date with its bar, the owner, next action, blocker, what is attached and the last update. **Update this item** opens the full update card; **Nothing changed** confirms it is still accurate. **Actions** has the rest: open the full update card, enter an update for someone else (administrators), and see the item on its pathway. Close the panel with the cross or the Esc key.

**Activity.** The item's owner, the leads of its reform and administrators also see an **Activity** tab: every update sent about the item, who approved or returned it and when, with the approver's note. Others see only the last update line.

**Needs your action.** At the top of My items, under the greeting, a short list shows what is waiting for you, each with one button: updates waiting for your approval (oldest first), confirmations you can approve together, updates returned to you, and updates the checks stopped. It disappears when nothing is waiting.

Reform leads and administrators also have a **My reforms** tab with every open item in their reforms. Tick **Show only items with no owner** to find items that still need someone responsible.

## Updating an item

Open an item from My items. The update card opens on its own page, without the menu, so you can concentrate: the cross at the top right (or Esc) takes you back to the item. The card shows the item's dates and, for the people who may see it, its Activity. The fields are in three sections you can fold away: **Status and dates**, **Next action and blockers**, and **Evidence**.

At the top of the form, a chip for each field turns green, amber or red as you type, following the same checks as the server. A field with a problem opens its section and says what to fix next to it.

1. Change what has changed. As you type, the card checks your update: red points must be fixed before it can be sent; amber points lower the quality score. You need a score of 80.
2. Select **Send for approval**. Your update is checked again on the server. If something needs fixing, the card says what, next to each field. Fix it and send again.
3. Once sent, an approver checks it. You get a notice when it is approved or returned (see **Notices**). If it is returned, the card shows the approver's note; fix it and send again. Nothing changes on the dashboard until it is approved.

If nothing has changed, select **Nothing changed: confirm it is still accurate**. This also goes to the approver, and keeps the item from showing as out of date.

Your changes are kept on your phone or computer until they are sent, so a dropped connection or a closed page loses nothing. If the connection fails while sending, the card tries again by itself.

If someone else's update to the same item is approved after you opened it, yours is returned so you can check it against the new version. Nothing is overwritten without anyone seeing it.

**An overdue item that still says "on track" cannot be sent as it is.** Change the status (for example to delayed), give a new expected date and say what is blocking it.

**Every open item needs an owner** who is a named person. If the card says the item has no owner, ask your reform lead to set one.

## Attaching evidence

In the update card, under **Attach a file**, take a photo or choose a file: PDF, JPG, PNG, Word (.docx) or Excel (.xlsx), up to 10 MB.

- Photos are made smaller on your phone before sending, to save data.
- On a poor connection the file carries on sending from where it stopped.
- Give each file a clear title, its type, the date of the document and the institution it came from.
- Files are checked when they arrive. Word or Excel files with macros are refused.
- An item marked complete needs evidence and the date it was completed.

Evidence files open through a link that works for one minute only, for people allowed to see them.

## Approving updates

For reform leads (their reforms, where they may approve), MERL officers (indicator values) and programme administrators (everything). **Approvals** at the top of the page shows how many updates are waiting for you.

1. Open **Approvals**. On the left, updates wait in a list grouped by the person who sent them, oldest first. Each shows the item, its reform, how it was sent and how many days it has waited (in red after a week). Only updates you may approve are listed; never your own, and never one entered for you.
2. Open one. In the middle you see what it is ("Update to Milestone MS-008: …"), who sent it and when, and a box with what the checks found: green when they passed, amber when there are points to look at, red when there is a problem. Below it, **What would change** lists each field with its current value crossed out and the proposed value in bold. New items show all their values.
3. On the right are the files: evidence, proof of an instruction, or the original upload. Select **Show preview** to see a photo in place; previews load only when you ask, to save data. Other files open in a new tab. Links work for one minute.
4. Decide in the bar at the bottom. **Approve** (or Ctrl + Enter); **Add a note** first if you want to. Or **Return for changes**, write what needs fixing and select **Return with this note**. Approvers cannot edit an update; return it instead. The next update opens straight away. **Previous** and **Next** (or the K and J keys) move through the list without deciding.
5. When you approve, the system checks again that nothing has changed since the update was sent. If something has, it says what and changes nothing; return the update so it can be redone.

Nothing is ever approved automatically: the checks only say what they found.

**Confirmations** ("nothing changed") can be approved together: open **Confirmations**, keep the ones you want ticked and select **Approve the selected confirmations**.

Super administrators approve only in an emergency: open **Note and break-glass**, tick break-glass and give a reason, which is recorded.

## Notices

**Notices** at the top of the page shows how many you have not read. You get a notice when your update is approved or returned (with the note), when an update is waiting for your approval, and when an administrator suggests training on the checks you trip most often.

Reminders also come as notices, and by email if your administrator has turned email on:

- an item is due in 3 days;
- an item is 1, 7 or 14 days overdue (you, and the person one step up, hear at each step);
- an item has not been confirmed for 30 days (then weekly until you update it or confirm nothing changed);
- a risk you own is past its review date;
- every Monday, a summary of your open items.

You get at most one reminder email a day. To stop the daily email, open **My account** and untick *Send me a daily email*. The notices and the Monday summary still come. Opening the page marks them read. Email notices come later.

## Review packs

**Reviews** in the menu lists the packs prepared for the monthly Pillar 1 review and the Quarterly Strategy Review. Each pack is kept exactly as it was prepared. Open one to read it in your language; **Print or save as PDF** gives a printable copy, and **Download the file** gives a copy to keep or email. Review packs are for programme staff only.

## My data quality

**My data quality**, under your initials at the top right, shows how your own updates did in the checks. Four tiles give your average score against the pass mark of 80, how often your updates passed first time, your attempts and how many the checks stopped. Below, your trend sits beside bars of the checks that stopped you most, with an example of each, and then the list of your attempts. Select a check to read it in plain words. Use it to see what to put right next time. Only you and the administrators can see these figures.

If fewer than three of your last five updates passed first time, the page says so. Look at the checks listed and ask the Secretariat if one is unclear.

## Entering an update for someone else

For programme administrators (the Secretariat). Use it when someone gives you an update by phone, WhatsApp, in a meeting or by letter, and does not enter it themselves.

1. Select **For someone else** at the top of the page.
2. Choose the person and select **Show their items**. Their open items are listed, overdue first.
3. Open an item. The card says who you are entering the update for.
4. Say **how you received it** and **when**. A short note is optional. You can attach proof of the instruction, for example a photo of the minute or a screenshot of the message. This is for the approver; it is not evidence that the work was done.
5. Fill in the update as usual and select **Send for approval**.

The update goes through the same checks and approval as any other. The person is told an update was entered for them, so they can say if it is wrong. Once approved, the item shows "entered by you for them". You cannot approve an update entered for you.

People who do not sign in must first be added to the system (see the administrator guide).

## Bulk upload

For programme administrators, MERL officers and reform leads. Everyone else updates items one by one in the update card.

1. Select **Bulk upload**, then **Upload and check**. Download the template there if you do not have it.
2. Fill only the sheets you need. Do not rename sheets or change the headings. Pick values from the drop-down lists, type dates as dates, and do not use formulas.
3. To update an item, give its existing ID and only the cells that change. **A blank cell leaves the stored value as it is.** To clear a value, use the update card.
4. Each owner is given by email address, and must already be in the system.
5. Upload the file (.xlsx or .csv, up to 5 MB). On a poor connection it carries on sending from where it stopped.

The file is checked straight away and you see a preview:

- The summary says how many rows need fixing, with **Show them** to jump there. Each sheet's tab shows how many of its rows need fixing, or a tick when it has none, and each row starts with a tick or a warning sign.
- **Red cells must be fixed. Amber cells lower the quality score.** The message for each one is in the Problems column, in your language, with the rule's number; select the number to read that check in plain words.
- Fix cells right there and select **Save fixes and check again**, or fix your file and select **Upload a corrected file**.
- **Download the list of problems (CSV)** gives every problem with its sheet, row and cell, to share or work through in Excel.
- When there are no red cells and the score is 80 or more, the upload goes to the approver as one package. Nothing changes on the dashboard until it is approved.

Some template columns are not used by the dashboard: validation_status on Stage_Updates (MERL validates evidence), and comments on Evidence_Register. The preview says when it ignored them.

**reported_by_email:** in an upload by the Secretariat, each row is recorded as entered for the person named in that column, who must be in the system and is told. Nobody named on any row can approve the file. In uploads by others, the column is recorded with the upload only.

**For now, new items in an upload need an ID.** The template says to leave the ID blank on a new workstream, deliverable, activity or action, but the data quality rules do not yet allow it (open question 25).

## The checks, in plain words

**?** at the top of every page, then **All the checks, in plain words**, lists every check an update goes through, grouped by what it does: **Must pass to send**, **Counts towards the score** (with its weight), **File checks** for bulk uploads, and **Fixed for you**. Search by a rule's number (such as B08) or by words. A rule number anywhere in the app (in Approvals, or in a bulk upload's problems) opens that rule here.

## My account

Select your initials at the top right, then **My account**, to see your name, email address, role, language and the reforms you work on.

## Choosing English or French

At the top right of every page there is a switch: **EN | FR**.

- Select **EN** for English or **FR** for French. The page reloads in that language.
- When you are signed in, your choice is saved to your profile, so it follows you to any device.
- On your first visit the site uses your browser's language if it is English or French. Otherwise it starts in English.

Dates are shown as 14 Nov 2026 in English and 14 nov. 2026 in French, in Kinshasa time.

## About the dashboard

The dashboard is open-source software under the MIT licence: anyone may use, copy, change and share the software. The programme's data is not open; it stays private to the programme. The line at the bottom of every page links to **About and source code**, which shows the licence, the copyright, the version you are using and a link to the source code. You can open it without signing in.

