// Browser enhancements for the update card. The form works without this file; with it:
//   - live hints from the same gate engine the server runs (the server still decides),
//   - unsent changes kept on the device (IndexedDB), so a dropped connection loses nothing,
//   - sending retries with backoff when the connection fails,
//   - photos made smaller, and resumable uploads (tus) for every file.
import * as tus from 'tus-js-client';
import { JPEG_QUALITY, jpegName, needsShrinking, targetSize } from '../lib/evidence/resize';
import { runGate } from '../lib/gate/engine';
import { withoutRowPrefix } from '../lib/gate/messages';
import type { GateContext, GateRow } from '../lib/gate/types';
import { buildUpdateRow, formValue, type DeliveryEntity } from '../lib/item-rows';

type Config = {
  entity: DeliveryEntity;
  id: string;
  /** The signed-in account: drafts are kept per person (decision 91). */
  owner: string;
  lang: 'en' | 'fr';
  version: string;
  fields: string[];
  context: GateContext;
  sent: boolean;
  strings: Record<string, string>;
  evidenceTypes: { code: string; label: string }[];
};
type Problem = { field: string | null; row: number | null; message: string; severity: string };
type Draft = { version: string; values: Record<string, string>; savedAt: number };


function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

// --- Drafts on the device ------------------------------------------------------------------
const DB_NAME = 'ggp-dashboard';
const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const STORE = 'drafts';

let connection: Promise<IDBDatabase> | undefined;

/** One connection per page, opened once. */
function openDb(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}

/**
 * Runs one request in its own transaction and resolves when the transaction is complete, so a
 * saved draft is on disk before the person can leave the page (a request's "success" alone is
 * not enough: an unfinished transaction is lost when the page closes).
 */
async function draftStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode, { durability: 'strict' });
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.commit();
    });
  } catch {
    return undefined; // Private browsing or storage blocked: the form still works.
  }
}

function start(form: HTMLFormElement, config: Config): void {
  const itemKey = `${config.entity}:${config.id}`;
  // Per person and item (decision 91): another account on the same browser never sees it.
  const draftKey = `${config.owner}:${itemKey}`;
  const status = form.querySelector<HTMLElement>('#card-status')!;
  const uploadStatus = form.querySelector<HTMLElement>('#upload-status')!;
  const pending = form.querySelector<HTMLElement>('#pending-uploads')!;
  const fileInput = form.querySelector<HTMLInputElement>('#evidence-file')!;
  // Files go by resumable upload instead of with the form.
  fileInput.removeAttribute('name');
  fileInput.multiple = true;

  const control = (field: string) => form.elements.namedItem(field) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  const currentValues = (): Record<string, string> =>
    Object.fromEntries(config.fields.map((field) => [field, control(field)?.value ?? '']));

  // --- Live hints ------------------------------------------------------------------------
  function rowsFromForm(): GateRow[] {
    const values = Object.fromEntries(config.fields.map((field) => [field, formValue(field, control(field)?.value ?? null)]));
    const stored = config.context.stored?.[itemKey] ?? {};
    const update = buildUpdateRow({ entity: config.entity, id: config.id, record: stored, version: config.version }, values, config.fields);
    // Each attached file counts as evidence linked to the item (B09). Only the item's own row
    // is shown as hints; the server checks each file's details when the update is sent.
    const evidence = [...pending.querySelectorAll<HTMLElement>('[data-upload-id]')].map(
      (): GateRow => ({ entity: 'evidence_item', op: 'create', fields: {}, links: [{ object_type: config.entity, object_id: config.id }] }),
    );
    return [update, ...evidence];
  }

  function showProblems(problems: Problem[]): void {
    for (const box of form.querySelectorAll<HTMLElement>('[data-hint-for]')) box.replaceChildren();
    const states = new Map<string, string>();
    for (const problem of problems) {
      if (problem.row !== null && problem.row !== 1) continue;
      const box = form.querySelector<HTMLElement>(`[data-hint-for="${problem.field ?? ''}"]`) ?? form.querySelector<HTMLElement>('[data-hint-for="_live"]');
      const line = document.createElement('p');
      line.className = problem.severity === 'error' ? 'hint-error' : 'hint-warning';
      line.textContent = problem.message;
      box?.append(line);
      // A problem inside a folded section opens it, so no hint is hidden.
      box?.closest('details')?.setAttribute('open', '');
      if (problem.field && states.get(problem.field) !== 'error') states.set(problem.field, problem.severity === 'error' ? 'error' : 'warning');
    }
    // The tick and cross chips at the top of the card follow the same findings.
    for (const chip of form.querySelectorAll<HTMLElement>('[data-chip-for]')) chip.dataset['state'] = states.get(chip.dataset['chipFor'] ?? '') ?? 'ok';
  }

  function liveCheck(): void {
    const result = runGate({ route: 'web_form', rows: rowsFromForm() }, config.context);
    showProblems(
      result.findings
        .filter((f) => f.severity !== 'fixed')
        .map((f) => ({ field: f.field, row: f.rowRef, severity: f.severity, message: withoutRowPrefix(config.lang === 'fr' ? f.messageFr : f.messageEn) })),
    );
    status.className = '';
    status.textContent = result.qualityScore === null ? '' : fill(config.strings['liveScore']!, { score: result.qualityScore });
  }

  // --- Drafts ----------------------------------------------------------------------------
  let saveTimer: number | undefined;
  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const draft: Draft = { version: config.version, values: currentValues(), savedAt: Date.now() };
      void draftStore('readwrite', (store) => store.put(draft, draftKey));
    }, 400);
  }
  const clearDraft = () => draftStore('readwrite', (store) => store.delete(draftKey));

  async function restoreDraft(): Promise<void> {
    if (config.sent) {
      await clearDraft();
      return;
    }
    const draft = (await draftStore<Draft | undefined>('readonly', (store) => store.get(draftKey))) ?? undefined;
    // A draft made against an older version of the item is dropped: the item has changed since.
    // So is one older than two weeks.
    if (!draft || draft.version !== config.version) return;
    if (Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS) {
      await clearDraft();
      return;
    }
    const unchanged = Object.entries(draft.values).every(([field, value]) => (control(field)?.value ?? '') === value);
    if (unchanged) return;
    for (const [field, value] of Object.entries(draft.values)) {
      const input = control(field);
      if (input) input.value = value;
    }
    const note = document.createElement('p');
    note.className = 'notice';
    note.dataset['testid'] = 'draft-restored';
    note.textContent = `${config.strings['draftRestored']} `;
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'button button-quiet';
    discard.textContent = config.strings['draftDiscard']!;
    discard.addEventListener('click', () => {
      void clearDraft().then(() => window.location.reload());
    });
    note.append(discard);
    form.prepend(note);
  }

  // --- Sending with retries --------------------------------------------------------------
  const RETRY_SECONDS = [2, 4, 8, 16, 30];

  /** Waits, showing the seconds left; stops early when the browser says the connection is back. */
  async function countdown(seconds: number): Promise<void> {
    let cameBack = false;
    const onOnline = () => (cameBack = true);
    window.addEventListener('online', onOnline, { once: true });
    for (let left = seconds; left > 0 && !cameBack; left--) {
      status.textContent = fill(config.strings['offlineRetry']!, { seconds: left });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    window.removeEventListener('online', onOnline);
  }
  async function send(submitter: HTMLButtonElement | null): Promise<void> {
    const body = new FormData(form, submitter);
    for (let attempt = 0; ; attempt++) {
      status.className = '';
      status.textContent = config.strings['sending']!;
      try {
        // The full address, so query parameters such as ?for= (entering for someone else) are kept.
        const response = await fetch(window.location.pathname + window.location.search, { method: 'POST', body, headers: { accept: 'application/json' }, credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = (await response.json()) as { ok: boolean; redirect?: string; submissionId?: string; score?: number | null; problems?: Problem[]; notice?: string | null };
        if (result.ok && result.redirect) {
          await clearDraft();
          window.location.assign(result.redirect);
          return;
        }
        const idField = form.elements.namedItem('submission_id') as HTMLInputElement | null;
        if (idField && result.submissionId) idField.value = result.submissionId;
        showProblems(result.problems ?? []);
        status.className = 'error';
        status.textContent = result.notice ?? [config.strings['rejected'], result.score == null ? '' : fill(config.strings['score']!, { score: result.score })].join(' ');
        status.focus();
        return;
      } catch (error) {
        const offline = error instanceof TypeError; // fetch gives TypeError when the network fails
        const wait = RETRY_SECONDS[attempt];
        if (!offline || wait === undefined) {
          status.className = 'error';
          status.textContent = config.strings['sendFailed']!;
          return;
        }
        await countdown(wait);
      }
    }
  }

  // --- Evidence uploads ------------------------------------------------------------------
  async function shrink(file: File): Promise<File> {
    if (!/^image\//.test(file.type)) return file;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    if (!bitmap || !needsShrinking(file.type, file.size, bitmap.width, bitmap.height)) return file;
    const size = targetSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    return blob ? new File([blob], jpegName(file.name), { type: 'image/jpeg' }) : file;
  }

  function addPending(uploadId: string, fileName: string): void {
    const box = document.createElement('div');
    box.className = 'upload stack';
    box.dataset['uploadId'] = uploadId;
    const field = (labelText: string, element: HTMLElement, id: string) => {
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = labelText;
      element.id = id;
      box.append(label, element);
    };
    const hidden = Object.assign(document.createElement('input'), { type: 'hidden', name: 'evidence_upload_id', value: uploadId });
    const name = document.createElement('p');
    name.textContent = fill(config.strings['ready']!, { name: fileName });
    box.append(hidden, name);
    field(config.strings['title']!, Object.assign(document.createElement('input'), { type: 'text', name: `evidence_title_${uploadId}`, value: fileName.replace(/\.[^.]+$/, '') }), `t-${uploadId}`);
    const select = Object.assign(document.createElement('select'), { name: `evidence_type_${uploadId}` });
    for (const option of config.evidenceTypes) select.append(new Option(option.label, option.code, option.code === 'other', option.code === 'other'));
    field(config.strings['type']!, select, `y-${uploadId}`);
    field(config.strings['date']!, Object.assign(document.createElement('input'), { type: 'date', name: `evidence_date_${uploadId}` }), `d-${uploadId}`);
    field(config.strings['source']!, Object.assign(document.createElement('input'), { type: 'text', name: `evidence_source_${uploadId}` }), `s-${uploadId}`);
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'button button-quiet', textContent: config.strings['remove']! });
    remove.addEventListener('click', () => {
      box.remove();
      liveCheck();
    });
    box.append(remove);
    pending.append(box);
  }

  /** Sends a file by resumable upload, has the server check it, then hands over the upload ID. */
  function upload(original: File, statusLine: HTMLElement, onReceived: (uploadId: string, fileName: string) => void): void {
    void shrink(original).then((file) => {
      const job = new tus.Upload(file, {
        endpoint: '/api/uploads',
        chunkSize: 1024 * 1024,
        retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000],
        metadata: { filename: file.name, filetype: file.type },
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => {
          statusLine.textContent = fill(config.strings['uploading']!, { name: file.name, percent: Math.floor((sent / total) * 100) });
        },
        onShouldRetry: () => {
          statusLine.textContent = config.strings['paused']!;
          return true;
        },
        onError: () => {
          statusLine.textContent = config.strings['failed']!;
        },
        onSuccess: async () => {
          statusLine.textContent = config.strings['checking']!;
          const response = await fetch('/api/evidence/receive', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ uploadUrl: job.url, fileName: file.name }),
          });
          const result = (await response.json().catch(() => ({ ok: false, reason: 'type' }))) as { ok: boolean; uploadId?: string; reason?: string };
          if (result.ok && result.uploadId) {
            statusLine.textContent = '';
            onReceived(result.uploadId, file.name);
          } else {
            statusLine.textContent = config.strings[`bad_${result.reason ?? 'type'}`] ?? config.strings['failed']!;
          }
        },
      });
      void job.findPreviousUploads().then((previous) => {
        if (previous[0]) job.resumeFromPreviousUpload(previous[0]);
        job.start();
      });
    });
  }

  // --- Wiring ----------------------------------------------------------------------------
  let checkTimer: number | undefined;
  form.addEventListener('input', () => {
    scheduleSave();
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(liveCheck, 300);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send((event as SubmitEvent).submitter as HTMLButtonElement | null);
  });
  fileInput.addEventListener('change', () => {
    for (const file of fileInput.files ?? []) {
      upload(file, uploadStatus, (uploadId, fileName) => {
        addPending(uploadId, fileName);
        liveCheck();
      });
    }
    fileInput.value = '';
  });

  // On-behalf entries: the file showing the instruction (decision 32).
  const instructionInput = form.querySelector<HTMLInputElement>('#instruction-file');
  const instructionStatus = form.querySelector<HTMLElement>('#instruction-status');
  const instructionId = form.elements.namedItem('instruction_upload_id') as HTMLInputElement | null;
  if (instructionInput && instructionStatus && instructionId) {
    instructionInput.removeAttribute('name');
    instructionInput.addEventListener('change', () => {
      const file = instructionInput.files?.[0];
      if (!file) return;
      upload(file, instructionStatus, (uploadId, fileName) => {
        instructionId.value = uploadId;
        instructionStatus.textContent = fill(config.strings['instructionReady']!, { name: fileName });
      });
      instructionInput.value = '';
    });
  }
  void restoreDraft();
}

// Start last, once everything above is declared.
const cardForm = document.querySelector<HTMLFormElement>('#update-card');
const configElement = document.querySelector('#card-config');
if (cardForm && configElement?.textContent) start(cardForm, JSON.parse(configElement.textContent) as Config);
