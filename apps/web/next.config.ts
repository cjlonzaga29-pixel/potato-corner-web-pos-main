import type { NextConfig } from 'next';
import withPWAInit from '@ducanh2912/next-pwa';

const withPWA = withPWAInit({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
});

const nextConfig: NextConfig = {
  transpilePackages: ['@potato-corner/shared'],
  // Proxies browser calls to the API backend through this same origin.
  // The API and this app live on different domains (Vercel vs Railway) —
  // without this, the HttpOnly refresh_token cookie the API sets would be
  // scoped to the API's own domain and never reach requests made to this
  // app, which is what apps/web/middleware.ts checks to gate protected
  // routes. Proxying makes every /api/* call same-origin from the
  // browser's perspective, so the cookie lands on the right domain.
  // `afterFiles` lets this app's own /api/health route handler still win.
  async rewrites() {
    // `||`, not `??` — Vercel's Preview/Development scopes currently have
    // this var set to an empty string rather than unset, and `??` only
    // falls back on null/undefined, not ''. An empty destination fails
    // Next.js's "must start with /, http://, or https://" rewrite check.
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    return {
      afterFiles: [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }],
    };
  },
};

export default withPWA(nextConfig);
