// Health check for the host's monitoring (decision 66): does the database answer, does file
// storage answer. Says nothing else: no versions, no counts, no names.
import type { APIRoute } from 'astro';
import { storage } from '../lib/platform/s3-storage';
import { inServerTransaction } from '../lib/server-db';

const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
  Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

export const GET: APIRoute = async () => {
  const database = await within(3000, inServerTransaction((db) => db.query('select 1')))
    .then(() => 'ok' as const)
    .catch(() => 'down' as const);
  const files = (await storage.reachable()) ? ('ok' as const) : ('down' as const);
  const ok = database === 'ok' && files === 'ok';
  return Response.json({ status: ok ? 'ok' : 'down', database, storage: files }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
};
