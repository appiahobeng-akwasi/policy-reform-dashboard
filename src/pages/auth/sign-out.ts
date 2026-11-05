import type { APIRoute } from 'astro';

// Signing out ends the session and clears what this site kept on the device, unsent update
// drafts included (decision 91), so the next person on a shared browser starts clean.
// Clear-Site-Data does it where the browser supports it; the shared page script also deletes
// the drafts database when the sign-out form is sent.
export const POST: APIRoute = async ({ locals }) => {
  await locals.auth.signOut();
  return new Response(null, { status: 303, headers: { location: '/', 'clear-site-data': '"storage"' } });
};
