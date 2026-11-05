// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';

// Server-rendered by default (low bandwidth). React only for interactive islands.
// The Node adapter in standalone mode runs on any host that can run Node, so the app is not
// tied to one hosting platform. ASTRO_ADAPTER=vercel (or a build on Vercel, which sets
// VERCEL=1) builds for Vercel's functions instead (decision 88); nothing else changes.
const adapterName = process.env.ASTRO_ADAPTER ?? (process.env.VERCEL === '1' ? 'vercel' : 'node');
if (adapterName !== 'node' && adapterName !== 'vercel') throw new Error(`ASTRO_ADAPTER must be node or vercel, not ${adapterName}.`);

export default defineConfig({
  output: 'server',
  adapter: adapterName === 'vercel' ? vercel() : node({ mode: 'standalone' }),
  integrations: [react()],
  security: {
    checkOrigin: true,
    // Strict Content Security Policy (spec 01 section 11, decision 62): Astro hashes its own
    // scripts and styles, so nothing inline runs unless Astro put it there. Images only from this
    // site (plus data: for the authenticator QR code and blob: for photo previews before upload).
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ],
    },
  },
});
