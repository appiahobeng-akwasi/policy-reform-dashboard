# Design system: "Growth"

Version 0.2, 4 Nov 2026. Supersedes v0.1 (3 Nov 2026, Ramp-inspired).

Direction from the product owner: keep the Ramp-style workflow (sidebar, search, summary numbers, a table, a side panel), but give it the feel of a health app's summary screens (soft canvas, big rounded cards, bold numbers in rings) with an underlying theme of green growth (deep forest green, emerald, leaf shapes). Show information as charts and visuals wherever that reads better than a list. Use gradients, not flat colours.

The concept that was approved is `docs/design/concept-v0.2.html`, with screenshots beside it. It uses sample figures for illustration only.

## 0. What we take, and what we do not

Take the references' **principles**, not their **brands**.

Do:
- A soft canvas with large white rounded cards and a light shadow.
- One forest-green hero card at the top of a page, with the page's main number in a ring and a short sentence that says what to do next.
- Big bold numbers, then a breakdown with a coloured dot and a count for each part ("4/6").
- A coloured chip for each reform area, the same everywhere.
- Charts instead of lists where a picture answers the question faster: rings, bars on a timeline, split bars, stage tracks, area charts.
- Every colour as a two-stop gradient, light to deep.
- The Ramp-style workflow from v0.1: sidebar, search, primary action, a table you can filter, a side panel that keeps your place.

Do not:
- Use any product's name, logo, icons, illustrations or screens.
- Put text in a gradient, or put text on the bright chart gradients.
- Show a chart without its numbers next to it.

Reason: this is an Funding Partner-funded government programme tool. It must look like GGP's own product.

## 1. Tokens (src/styles/tokens.css)

Existing variable names are kept; their values changed in v0.2.

Neutrals:

| Token | Value | Use |
|---|---|---|
| --color-bg | #ffffff | Inputs, plain surfaces |
| --color-canvas | #f2f4f0 | App background |
| --color-surface | #ffffff | Cards, tables, side panel |
| --color-surface-hover | #f1f4ef | Row hover |
| --color-border | #e4e8e2 | Lines inside cards and tables |
| --color-border-strong | #cfd6cf | Inputs |
| --color-text | #121815 | Main text |
| --color-text-muted | #5e6862 | Labels, secondary text |
| --color-text-faint | #8a938d | Placeholders only (below 4.5:1) |

Brand and action:

| Token | Value | Use |
|---|---|---|
| --color-forest | #0e3b30 | Hero cards, sign-in |
| --color-forest-text | #bfe8d6 | Secondary text on forest |
| --color-primary | #006b4d | Primary buttons (solid fallback of the gradient) |
| --color-accent | #006b4d | Selected nav icon, links, focus |
| --color-accent-soft | #e3f5ee | Selected row, active filter |

RAG and status colours keep their meaning and their text label (pills: tinted background, darker text).

Gradients (each runs light to deep at 135 degrees):

| Token | Light → deep | Use |
|---|---|---|
| --gradient-forest | #17604d → #082a22 | Hero cards, sign-in |
| --gradient-primary | #067f5c → #00553d | Primary buttons |
| --gradient-danger | #d03c29 → #a8281a | Count badges, danger buttons |
| --gradient-emerald | #4fe0ad → #008a63 | Brand, passed, done stages |
| --gradient-leaf | #c2ec74 → #4fb548 | On track, green |
| --gradient-sun | #ffd66e → #f0971c | Stale, amber |
| --gradient-coral | #ff9b7a → #e0453a | Overdue, red |
| --gradient-sky | #8db8ff → #3a68dc | Waiting, blue |
| --gradient-elapsed | #e1e7e2 → #c9d3cc | The used part of a timeline |
| --gradient-*-soft | pale tints | Pills, reform chips, selected rows |

Chart strokes use the same pairs (src/lib/charts.ts `PALETTE`), drawn by the server as SVG gradients.

Reform areas (fixed, everywhere):

| Reform | Colour | Soft chip | Icon |
|---|---|---|---|
| RA1 Land governance | #a84d1b | #fdf3ec → #f8dcc9 | land |
| RA2 Agricultural finance | #3a68d0 | #f1f6fe → #d8e5fb | coin |
| RA3 Value chains | #1f7d52 | #eefaf3 → #d2efdf | sprout |
| Programme-wide | #5b636e | #f3f4f5 → #e4e7ea | globe |

Type:
- System fonts, nothing to download: `-apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
- Scale: 12 / 13 / 14 / 16 / 20 / 28 / 40 px. Weights 400, 500, 600, and 800 for hero numbers only.
- `font-variant-numeric: tabular-nums` wherever digits line up.

Shape and space:
- Radius: 10 px (inputs, buttons), 20 px (cards, hero, side panel), round (pills, chips, rings).
- Shadow: one soft card shadow (`--shadow-card`); a stronger one for floating layers (`--shadow-float`).
- Spacing scale unchanged: 4, 8, 12, 16, 24, 32, 48 px. Table rows at least 40 px (44 px on touch screens).

Dark theme: not in Phase 1. The light canvas with forest hero cards reads well in bright light and prints cleanly.

## 2. Layout

- **Left sidebar** (232 px, on the canvas): sprout mark and GGP Pillar 1, then Work, Views and Admin (as v0.1). The current page sits on a white rounded card with an emerald icon. Icons only on medium screens.
- **Top bar** (decision 78): search (Ctrl/Cmd + K) on a white rounded field; EN | FR; Notices as a bell with a count; "+" New, listing what your role can start, each with an icon and one line; "?" Help, with how an update is approved and the shortcuts; your initials, for My account, My data quality and Sign out; then the page's primary action as a green gradient button. Menus are `<details>`: they work without JavaScript, and the shared script closes them on Esc or a click elsewhere.
- **Counts** show as pills: red beside Approvals in the sidebar, grey beside tab names ("Owned by me 5").
- **Getting started** (decision 80): a small card at the top of the sidebar for people who send updates, until their first update, first evidence and (approvers) first review.
- **Icons**: one per kind of thing, everywhere, on a soft round chip: milestone flag, deliverable box, activity checklist, workstream layers, risk triangle, decision scales, evidence paperclip, indicator chart, review calendar, confirmation tick, returned arrow.
- **Phones**: a floating tab bar at the bottom with My items, Approvals (people who approve, with the count), Views and Menu. Menu opens the full sidebar. It needs no JavaScript.
- **Content width**: tables use the full width; reading pages cap at 720 px.

## 3. Page pattern

1. **Title row**: page name, one line on what it is for, "Data as of …" in muted text.
2. **Hero card** (forest gradient): the page's main number in a ring, a sentence saying what to do next, and the ring's breakdown with dots and counts.
3. **Stat row**: small white cards that filter the table below.
4. **Table** in one white rounded card: each row starts with the reform chip, then the name; dates are shown with a due bar; status and rating as pills.
5. **Side panel** (480 px, from the right, Esc closes), as v0.1.

**Focus pattern** (decision 84): one task on its own page with a close button (and Esc) back to where you came from; the form folds into sections; a chip per field shows what the checks say as you type.

**Panel pattern**: title with an Actions menu beside the close button; a coloured warning line when the item needs something; the key number large (the due date with its bar); facts; the main actions as buttons; Overview and Activity tabs where Activity is allowed.

**Inbox pattern** (Approvals, decision 79): a list on the left grouped by person; the open item in the middle with its title, a meta line, a box saying what the checks found (green passed, amber points to look at, red problems; never a recommendation, decision 83), and the changes as rows (old value struck through, new value bold); files on the right, previewed on request; and a fixed bar at the bottom: Previous (K) and Next (J) on the left, Return for changes (opens the required note) and Approve (Ctrl + Enter) on the right. On phones the list and the detail stack and the bar sits above the tab bar.

## 4. Charts

All charts are server-rendered SVG with gradient strokes, no chart library and no script. Each chart has a text alternative (`role="img"` with a label, or the numbers beside it) and never relies on colour alone.

| Component | Shows | Where |
|---|---|---|
| Ring | Parts of a whole (items by state) with the main number in the middle | My items hero; later Executive, data quality |
| DueBar | Days overdue (coral) or days left (emerald) on a 90-day scale, with the exact text below | My items rows, update card |
| ReformChip | The reform's icon on its soft gradient, with its code and name | Rows, cards, update card |
| Gauge (Ring with one score) | One score out of 100 filling clockwise, round ends inside its share, a full ring at 100 | Executive trend, Portfolio readiness, data quality |
| SplitBar | Parts of a whole in one rounded bar, widths in 5% steps adding to 100, a part that is not zero always visible; legend with counts | Executive ratings, Governance actions |
| AuthBrand | The sign-in pages' brand panel: forest gradient, Green Growth Programme and the DRC, Pillar 1, a two-line headline, the three reform areas as chips, faint contour lines drawn inline. Left 55% of the screen; a band above the form on a phone | Sign-in, Check your email, Finish signing in, authenticator (decision 90) |
| LinkTabs | Tabs that are links (`?tab=`): one section of a page at a time, a count pill on each, the row scrolls inside itself on a phone | Risks, Governance, MERL, data quality (decision 90) |
| StatCard (dot) | A stat tile with a small level dot before its label (red, amber, green) | Risks (decision 90) |
| EmptyState (title, icon) | An icon, a short title and one sentence instead of a bare "None" | Risks and the redesigned views (decision 90) |
| StageTrack | The 8 pathway stages: done (emerald), current (leaf, ringed), to come | Executive, Portfolio, Pathway on a phone |
| PathwayBoard | Every reform against the 8 stages: one dot per stage on a thin line, green as far as reached; filled done, ringed in progress (red ring blocked), hollow to come, amber sign for escalation. A real table; each dot is a link to the stage panel named in words | Pathway (decision 89) |
| PathwayStepper | One reform's stages as numbered circles on one line, a tick when complete; each step links to the stage panel. Stacks vertically on a phone | Pathway (decision 89) |
| DeliveryTable | Activities and milestones: ID, item, owner, due with days late in red text, rating pill. Overdue first, first five then "Show more" (details). Two-line rows on a phone. No due bars | Pathway (decision 89) |
| AreaChart (QualityTrend, Sparkline) | A trend: gradient line, fading fill, pass mark, latest value named; a hidden table for screen readers | Executive, MERL, data quality |
| BarList | Ranked bars against the largest, name and number in text | Portfolio distribution, Risks bottlenecks, failing rules |
| Show the numbers | The exact table under a chart, folded, opened on request | Risks bottlenecks, MERL breakdowns, admin data quality |

Ring drawing: each part is one closed outline (its arc and round ends), shaded from light to deep along its whole length. Round ends stay inside the part's own share, so every gap between parts is the same and nothing overlaps. A part too small to see is shown as a round dot one ring-width long, taking the space from the larger parts; the exact numbers are printed beside the ring.

DueBar scale: a full bar is 90 days or more. Overdue items fill coral by days overdue; upcoming items fill emerald by days left. Items with no due date have no bar.

## 5. Behaviour

As v0.1: instant feedback, Ctrl/Cmd + K and / for search, Esc closes, numbers and dates in the reader's language, 150 ms ease-out motion for the panel and menus only, and `prefers-reduced-motion` respected.

## 6. Constraints that stay in force

- Low bandwidth (CLAUDE.md): server-rendered pages; hand-written SVG; no images, fonts or scripts from other sites; each view under 150 KB on Slow 3G.
- Accessibility: text at least 4.5:1 against **both ends** of any gradient behind it; icons and chart parts that carry meaning have their text beside them; visible focus ring; full keyboard use. `tests/unit/contrast.test.ts` checks every pair.
- English and French on every page; French is often 20 to 30% longer, so nothing has a fixed width.

## 7. Rollout

1. First group: tokens, the shell and phone tab bar, Ring, DueBar and ReformChip, then My items, sign-in, the update card and bulk upload. All other pages take the new tokens straight away but keep their layout.
2. Second group, after review: Executive, Portfolio, Pathway, Risks, MERL, Governance and the data quality pages, with Gauge, SplitBar, StageTrack and AreaChart.

## 8. Acceptance check

Show the project lead My items and the Executive view on a laptop and on a phone over throttled 3G. Both should feel calm, load fast and make the next action obvious.
