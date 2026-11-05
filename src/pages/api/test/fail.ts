// Fails on purpose, so the tests can see an error logged and shown with a reference. Exists only
// when ENABLE_TEST_ROUTES=true (the test server); everywhere else it is "not found".
import type { APIRoute } from 'astro';
import { env } from '../../../lib/env';

export const GET: APIRoute = () => {
  if (!env.testRoutes) return new Response(null, { status: 404 });
  throw new Error('Test failure for alice@example.com with token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl');
};
