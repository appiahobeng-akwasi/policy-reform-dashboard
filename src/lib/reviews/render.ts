// Words a saved review pack in the reader's language (decision 53). One renderer for the page,
// the print layout and the downloaded file, so all three always say the same. Everything from
// the data is escaped; the file has its styles inline and no scripts, so it works offline.
import { formatDate, formatDateTime, formatNumber, t, type Lang, type MessageKey } from '../../i18n';
import packCss from '../../styles/pack.css?raw';
import type { Names, PackData, PackDecision, PackItem, PackValue, ReviewType } from './pack';

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const name = (lang: Lang, n: Names | null): string => (n ? (lang === 'fr' && n.fr ? n.fr : n.en) : '');
const tryT = (lang: Lang, key: string, fallback: string, vars: Record<string, string | number> = {}): string => {
  try {
    return t(lang, key as MessageKey, vars);
  } catch {
    return fallback;
  }
};
const day = (lang: Lang, value: string | null): string => (value ? formatDate(value.slice(0, 10), lang) : t(lang, 'reviews.none'));
const typeLabel = (lang: Lang, objectType: string) => tryT(lang, `items.type_${objectType}`, tryT(lang, `jobs.type_${objectType}`, objectType));

export function reviewTypeLabel(lang: Lang, type: ReviewType): string {
  return t(lang, `reviews.type_${type}` as MessageKey);
}

/** The title a pack is known by: "Monthly Pillar 1 review, 14 Nov 2026 (version 2)". */
export function packTitle(lang: Lang, type: ReviewType, reviewDate: string, version: number): string {
  return t(lang, 'reviews.pack_title', { type: reviewTypeLabel(lang, type), date: formatDate(reviewDate, lang), version });
}

function table(headings: string[], rows: string[][], numeric: number[] = []): string {
  const cls = (i: number) => (numeric.includes(i) ? ' class="number"' : '');
  return `<table><thead><tr>${headings.map((h, i) => `<th scope="col"${cls(i)}>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

const empty = (lang: Lang, key: MessageKey) => `<p class="muted">${escape(t(lang, key))}</p>`;
const sample = (lang: Lang, isSample: boolean) => (isSample ? ` <span class="badge">${escape(t(lang, 'views.sample'))}</span>` : '');
const item = (lang: Lang, i: Pick<PackItem, 'objectType' | 'objectId' | 'name' | 'isSample'>) =>
  `${escape(`${typeLabel(lang, i.objectType)} ${i.objectId}`)}: ${escape(i.name)}${sample(lang, i.isSample)}`;
const value = (lang: Lang, v: PackValue | null, unit: string | null) =>
  v === null || v.value === null ? escape(t(lang, 'reviews.none')) : escape(`${formatNumber(v.value, lang)}${unit === '%' ? '%' : ''}`);
const tier = (lang: Lang, n: number | null) => (n ? escape(t(lang, `reviews.tier_${n}` as MessageKey)) : escape(t(lang, 'reviews.tier_unset')));

function decisionRows(lang: Lang, decisions: PackDecision[]): string[][] {
  return decisions.map((d) => [
    `<strong>${escape(d.decisionId)}</strong> ${escape(day(lang, d.date))}<br>${escape(d.summary)}`,
    escape(d.reforms.join(', ') || t(lang, 'reviews.programme_wide')),
    tier(lang, d.tier),
    `${escape(d.followUpAction ?? t(lang, 'reviews.none'))}${d.followUpOwner ? `<br><span class="muted">${escape(d.followUpOwner)}</span>` : ''}`,
    `${escape(day(lang, d.followUpDue))}${d.followUpOverdue ? ` <span class="badge red">${escape(t(lang, 'reviews.overdue'))}</span>` : ''}`,
  ]);
}

/** The pack's body: four parts in the order the meeting uses them. */
export function renderPackBody(lang: Lang, pack: PackData, meta: { version: number; generatedAt: string; generatedBy: string }): string {
  const p = pack.prepare;
  const r = pack.review;
  const parts: string[] = [];

  parts.push(`<p class="meta">${escape(
    t(lang, 'reviews.prepared_by', { name: meta.generatedBy, date: formatDateTime(meta.generatedAt, lang), since: formatDate(pack.windowStart.slice(0, 10), lang) }),
  )}</p>`);
  parts.push(`<p class="notice">${escape(t(lang, 'reviews.data_as_of', { date: day(lang, pack.dataAsOf), stale: p.staleTotal }))}</p>`);
  if (p.reforms.some((x) => x.hasSample) || r.overdue.some((x) => x.isSample)) parts.push(`<p class="notice">${escape(t(lang, 'views.sample_note'))}</p>`);

  // 1. Prepare
  parts.push(`<h2>1. ${escape(t(lang, 'reviews.prepare'))}</h2><p class="muted">${escape(t(lang, 'reviews.prepare_intro'))}</p>`);
  parts.push(
    table(
      [t(lang, 'views.filter_reform'), t(lang, 'reviews.stage'), t(lang, 'views.filter_rag'), t(lang, 'views.overdue'), t(lang, 'views.due_30'), t(lang, 'views.stale'), t(lang, 'views.risks_high'), t(lang, 'views.decisions_open')],
      p.reforms.map((x) => [
        `<strong>${escape(x.reformId)}</strong> ${escape(name(lang, x.name))}${sample(lang, x.hasSample)}`,
        escape(name(lang, x.stage)),
        escape(tryT(lang, `reviews.rag_${x.rag}`, x.rag)),
        String(x.overdue),
        String(x.due30),
        String(x.stale),
        x.risksHigh === null ? '' : String(x.risksHigh),
        x.decisionsOpen === null ? '' : String(x.decisionsOpen),
      ]),
      [3, 4, 5, 6, 7],
    ),
  );
  parts.push(`<h3>${escape(t(lang, 'views.programme'))}</h3>`);
  parts.push(
    p.programme.length === 0
      ? empty(lang, 'views.programme_none')
      : table(
          [t(lang, 'reviews.item'), t(lang, 'reviews.due'), t(lang, 'views.filter_rag')],
          p.programme.map((x) => [item(lang, x), escape(day(lang, x.dueDate)), escape(tryT(lang, `reviews.rag_${x.rag}`, x.rag))]),
        ),
  );
  parts.push(
    `<p>${escape(
      p.quality.attempts === 0
        ? t(lang, 'reviews.quality_none')
        : t(lang, 'reviews.quality', {
            attempts: p.quality.attempts,
            rate: p.quality.firstTimePassRate === null ? t(lang, 'reviews.none') : `${formatNumber(p.quality.firstTimePassRate, lang)}%`,
            score: p.quality.averageScore === null ? t(lang, 'reviews.none') : formatNumber(p.quality.averageScore, lang),
          }),
    )}</p>`,
  );

  // 2. Review
  parts.push(`<h2>2. ${escape(t(lang, 'reviews.review'))}</h2>`);
  parts.push(`<h3>${escape(t(lang, pack.reviewType === 'monthly_pillar_review' ? 'reviews.escalations_monthly' : 'reviews.escalations_qsr'))}</h3>`);
  parts.push(
    r.escalations.length === 0
      ? empty(lang, 'reviews.escalations_none')
      : table(
          [t(lang, 'reviews.level'), t(lang, 'reviews.item'), t(lang, 'reviews.why'), t(lang, 'reviews.owner'), t(lang, 'reviews.since')],
          r.escalations.map((e) => [
            String(e.level),
            `${escape(`${typeLabel(lang, e.objectType)} ${e.objectId}`)}${e.name ? `: ${escape(name(lang, e.name))}` : ''}${e.reformId ? ` <span class="muted">(${escape(e.reformId)})</span>` : ''}`,
            escape(tryT(lang, `views.reason_${e.reason}`, e.reason)),
            escape(e.owner ?? t(lang, 'dq.no_owner')),
            escape(day(lang, e.raisedAt)),
          ]),
          [0],
        ),
  );
  parts.push(`<h3>${escape(t(lang, 'reviews.overdue_title', { n: r.overdue.length }))}</h3>`);
  parts.push(
    r.overdue.length === 0
      ? empty(lang, 'reviews.overdue_none')
      : table(
          [t(lang, 'views.filter_reform'), t(lang, 'reviews.item'), t(lang, 'reviews.owner'), t(lang, 'reviews.due'), t(lang, 'reviews.days_late')],
          r.overdue.map((x) => [
            escape(x.reformId ?? t(lang, 'reviews.programme_wide')),
            item(lang, x),
            escape(x.owner ?? t(lang, 'dq.no_owner')),
            escape(day(lang, x.dueDate)),
            String(x.daysOverdue),
          ]),
          [4],
        ),
  );
  parts.push(`<h3>${escape(t(lang, 'reviews.risk_changes'))}</h3>`);
  parts.push(
    r.riskChanges.length === 0
      ? empty(lang, 'reviews.risk_changes_none')
      : table(
          [t(lang, 'reviews.risk'), t(lang, 'reviews.change'), t(lang, 'reviews.when')],
          r.riskChanges.map((c) => [
            `<strong>${escape(c.riskId)}</strong> ${escape(c.description)}`,
            escape(
              t(lang, `reviews.change_${c.change}` as MessageKey, {
                before: c.before ? `${c.before.inherent ?? '?'}/${c.before.residual ?? '?'}` : '',
                after: `${c.after.inherent ?? '?'}/${c.after.residual ?? '?'}`,
                status: tryT(lang, `reviews.risk_status_${c.after.status}`, c.after.status),
              }),
            ),
            escape(day(lang, c.at)),
          ]),
        ),
  );
  parts.push(`<h3>${escape(t(lang, 'reviews.high_risks'))}</h3>`);
  parts.push(
    r.highRisks.length === 0
      ? empty(lang, 'reviews.high_risks_none')
      : table(
          [t(lang, 'reviews.risk'), t(lang, 'reviews.scores'), t(lang, 'reviews.owner'), t(lang, 'reviews.review_due')],
          r.highRisks.map((k) => [
            `<strong>${escape(k.riskId)}</strong> ${escape(k.description)}${k.reforms.length ? ` <span class="muted">(${escape(k.reforms.join(', '))})</span>` : ''}`,
            escape(`${k.inherent ?? '?'} / ${k.residual ?? '?'}`),
            escape(k.owner ?? t(lang, 'dq.no_owner')),
            `${escape(day(lang, k.reviewDate))}${k.reviewOverdue ? ` <span class="badge red">${escape(t(lang, 'reviews.overdue'))}</span>` : ''}`,
          ]),
        ),
  );
  parts.push(`<h3>${escape(t(lang, 'reviews.indicators'))}</h3><p class="muted">${escape(t(lang, 'reviews.indicators_note'))}</p>`);
  parts.push(
    r.indicators.length === 0
      ? empty(lang, 'reviews.indicators_none')
      : table(
          [t(lang, 'reviews.indicator'), t(lang, 'reviews.latest'), t(lang, 'reviews.previous'), t(lang, 'reviews.target_y1'), t(lang, 'reviews.target_lop')],
          r.indicators.map((i) => [
            `<strong>${escape(i.code)}</strong> ${escape(name(lang, i.name))}${i.reformId ? ` <span class="muted">(${escape(i.reformId)})</span>` : ''}${
              i.newSinceLastReview ? ` <span class="badge">${escape(t(lang, 'reviews.new'))}</span>` : ''
            }`,
            `${value(lang, i.latest, i.unit)} <span class="muted">${escape(day(lang, i.latest.periodEnd))}${i.latest.isProxy ? `, ${escape(t(lang, 'reviews.proxy'))}` : ''}${
              i.latest.confidence ? `, ${escape(tryT(lang, `reviews.confidence_${i.latest.confidence}`, i.latest.confidence))}` : ''
            }</span>`,
            i.previous ? `${value(lang, i.previous, i.unit)} <span class="muted">${escape(day(lang, i.previous.periodEnd))}</span>` : escape(t(lang, 'reviews.none')),
            i.targetY1 !== null ? escape(formatNumber(i.targetY1, lang)) : escape(i.targetY1Text ?? t(lang, 'reviews.none')),
            i.targetLop !== null ? escape(formatNumber(i.targetLop, lang)) : escape(t(lang, 'reviews.target_lop_unconfirmed')),
          ]),
        ),
  );

  // 3. Decide
  parts.push(`<h2>3. ${escape(t(lang, 'reviews.decide'))}</h2><p class="muted">${escape(t(lang, 'reviews.tiers'))}</p>`);
  const decisionHead = [t(lang, 'reviews.decision'), t(lang, 'views.filter_reform'), t(lang, 'reviews.tier'), t(lang, 'reviews.follow_up'), t(lang, 'reviews.due')];
  parts.push(pack.decide.open.length === 0 ? empty(lang, 'reviews.decisions_none') : table(decisionHead, decisionRows(lang, pack.decide.open)));
  parts.push(`<h3>${escape(t(lang, 'reviews.decisions_today'))}</h3>`);
  parts.push(table([t(lang, 'reviews.decision'), t(lang, 'reviews.tier'), t(lang, 'reviews.follow_up'), t(lang, 'reviews.owner'), t(lang, 'reviews.due')], [1, 2, 3].map(() => ['&nbsp;', '', '', '', ''])));
  parts.push(`<p class="muted">${escape(t(lang, 'reviews.record_decisions'))}</p>`);

  // 4. Track
  parts.push(`<h2>4. ${escape(t(lang, 'reviews.track'))}</h2>`);
  parts.push(`<h3>${escape(t(lang, 'reviews.implemented'))}</h3>`);
  parts.push(pack.track.implemented.length === 0 ? empty(lang, 'reviews.implemented_none') : table(decisionHead, decisionRows(lang, pack.track.implemented)));
  parts.push(`<h3>${escape(t(lang, 'reviews.actions'))}</h3>`);
  parts.push(
    pack.track.actions.length === 0
      ? empty(lang, 'reviews.actions_none')
      : table(
          [t(lang, 'reviews.action'), t(lang, 'reviews.owner'), t(lang, 'reviews.due'), t(lang, 'reviews.status')],
          pack.track.actions.map((a) => [
            `<strong>${escape(a.actionId)}</strong> ${escape(a.description)}`,
            escape(a.owner ?? t(lang, 'dq.no_owner')),
            `${escape(day(lang, a.dueDate))}${a.overdue ? ` <span class="badge red">${escape(t(lang, 'reviews.overdue'))}</span>` : ''}`,
            escape(tryT(lang, `reviews.action_${a.status}`, a.status)),
          ]),
        ),
  );
  return `<div class="pack">${parts.join('\n')}</div>`;
}

/** Styles for the pack: bundled on the page, inlined in the file (which has no other styles). */
export const PACK_CSS: string = packCss;

/** A complete file: open it in any browser, print it, save it as PDF or email it. */
export function renderPackDocument(lang: Lang, pack: PackData, meta: { version: number; generatedAt: string; generatedBy: string }, note: string | null = null): string {
  const title = packTitle(lang, pack.reviewType, pack.reviewDate, meta.version);
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>body{max-width:60rem;margin:1.5rem auto;padding:0 1rem}${PACK_CSS}.print-note{font-family:Arial,sans-serif;color:#555}@media print{.print-note{display:none}}</style></head>
<body>${note ? `<p class="print-note">${escape(note)}</p>` : ''}<h1 style="font-family:Arial,sans-serif;font-size:1.5rem">${escape(title)}</h1>
<p style="font-family:Arial,sans-serif">${escape(t(lang, 'app.programme'))}</p>
${renderPackBody(lang, pack, meta)}</body></html>`;
}

/** A file name that sorts by date: pillar1-monthly-review-2026-11-14-v2-en.html */
export function packFileName(type: ReviewType, reviewDate: string, version: number, lang: Lang): string {
  return `pillar1-${type === 'monthly_pillar_review' ? 'monthly-review' : 'qsr'}-${reviewDate}-v${version}-${lang}.html`;
}
