// Sends the workbook by resumable upload (spec: resumable above 2 MB), then asks the server to
// read and check it. Without JavaScript the form posts the file instead.
import * as tus from 'tus-js-client';

const form = document.querySelector<HTMLFormElement>('#bulk-form');
const input = form?.querySelector<HTMLInputElement>('#file');
const status = form?.querySelector<HTMLElement>('#bulk-status');

if (form && input && status) {
  const strings = JSON.parse(form.dataset['strings'] ?? '{}') as Record<string, string>;
  const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  form.addEventListener('submit', (event) => {
    const file = input.files?.[0];
    if (!file) return;
    event.preventDefault();
    const previous = (form.elements.namedItem('previous') as HTMLInputElement | null)?.value ?? '';
    const upload = new tus.Upload(file, {
      endpoint: '/api/uploads',
      chunkSize: 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000],
      metadata: { filename: file.name },
      removeFingerprintOnSuccess: true,
      onProgress: (sent, total) => {
        status.textContent = fill(strings['uploading'] ?? '', { name: file.name, percent: Math.floor((sent / total) * 100) });
      },
      onShouldRetry: () => {
        status.textContent = strings['paused'] ?? '';
        return true;
      },
      onError: () => {
        status.textContent = strings['failed'] ?? '';
      },
      onSuccess: async () => {
        status.textContent = strings['checking'] ?? '';
        // Skeleton rows while the server reads and checks the workbook (docs/08: no spinners).
        for (let i = 0; i < 3; i++) status.append(Object.assign(document.createElement('span'), { className: 'skeleton' }));
        const response = await fetch('/api/bulk/receive', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uploadUrl: upload.url, fileName: file.name, previous }),
        });
        const result = (await response.json().catch(() => ({}))) as { redirect?: string };
        if (result.redirect) window.location.assign(result.redirect);
        else status.textContent = strings['failed'] ?? '';
      },
    });
    void upload.findPreviousUploads().then((found) => {
      if (found[0]) upload.resumeFromPreviousUpload(found[0]);
      upload.start();
    });
  });
}
