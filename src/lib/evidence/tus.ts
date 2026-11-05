// Resumable uploads with the tus protocol (tus.io): a file sent over a poor connection carries
// on from where it stopped. Uploads go straight to S3-compatible storage as "incoming-…"
// objects; receiveUpload() checks them before they can be attached.
//
// Note for hosting: with more than one app server, tus needs a shared locker and cache
// (for example Redis). One server is fine for the prototype.
import { randomBytes } from 'node:crypto';
import { S3Store } from '@tus/s3-store';
import { Server } from '@tus/server';
import { env } from '../env';
import { s3ClientConfig } from '../platform/s3-storage';
import { MAX_EVIDENCE_BYTES } from './sniff';
import { INCOMING_PREFIX } from './receive';

export const UPLOAD_PATH = '/api/uploads';
export const OWNER_HEADER = 'x-dashboard-uploader';

let server: Server | undefined;

export function tusServer(): Server {
  server ??= new Server({
    path: UPLOAD_PATH,
    relativeLocation: true,
    respectForwardedHeaders: false,
    maxSize: MAX_EVIDENCE_BYTES,
    namingFunction: () => `${INCOMING_PREFIX}${randomBytes(16).toString('hex')}`,
    datastore: new S3Store({
      partSize: 5 * 1024 * 1024,
      useTags: false,
      s3ClientConfig: { ...s3ClientConfig(), bucket: env.s3.bucket },
    }),
    // The uploader is set by our own endpoint from the signed-in session, never by the browser.
    async onUploadCreate(req, upload) {
      const owner = req.headers.get(OWNER_HEADER);
      if (!owner) throw { status_code: 401, body: 'Sign in first.\n' };
      return { metadata: { ...upload.metadata, owner } };
    },
    async onIncomingRequest(req, uploadId) {
      if (req.method === 'POST' || req.method === 'OPTIONS') return;
      const upload = await server!.datastore.getUpload(uploadId).catch(() => null);
      if (upload && upload.metadata?.['owner'] !== req.headers.get(OWNER_HEADER)) throw { status_code: 403, body: 'Not your upload.\n' };
    },
  });
  return server;
}

/** The storage ID at the end of an upload URL (…/api/uploads/incoming-abc). */
export function storageIdFromUrl(url: string): string | null {
  const id = url.split('/').pop() ?? '';
  return id.startsWith(INCOMING_PREFIX) && /^[\w-]+$/.test(id) ? id : null;
}
