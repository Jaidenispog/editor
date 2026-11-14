import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Next.js configuration for the Studio Assistant web app.
 * Workspace packages ship TypeScript source, so they are transpiled here; native or connection-heavy
 * server libraries stay external so they load from node_modules at runtime.
 */

/**
 * Origins other than localhost that may load the dev server's own resources (/_next/*, including the hot-reload
 * websocket). `next dev` refuses those from any other origin unless they are listed, and without them the page
 * shows but never becomes interactive, so the sign-in and setup forms do nothing. Only relevant when WEB_HOST
 * makes the dev server listen beyond this computer: then this computer's own IPv4 addresses are allowed, plus any
 * host names listed (comma-separated) in WEB_DEV_ORIGINS, such as my-laptop.local. `next start` ignores this.
 */
function lanDevOrigins(): string[] {
  const host = process.env.WEB_HOST?.trim();
  if (!host || ['127.0.0.1', 'localhost', '::1'].includes(host)) return [];
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => a !== undefined && !a.internal && a.family === 'IPv4')
    .map((a) => a.address);
  const extra = (process.env.WEB_DEV_ORIGINS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return [...new Set([...addresses, ...extra])];
}

const nextConfig: NextConfig = {
  output: 'standalone',
  allowedDevOrigins: lanDevOrigins(),
  // Monorepo root, so the standalone output traces the workspace packages correctly.
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  experimental: {
    // Workspace packages use ESM-style ".js" suffixes on relative imports of ".ts" files (TypeScript's
    // recommended style). Webpack maps them back to the TypeScript sources; Turbopack has no equivalent
    // option yet, so dev and build run with --webpack.
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@studio/core', '@studio/db', '@studio/storage', '@studio/queue', '@studio/config', '@studio/ai', '@studio/media'],
  serverExternalPackages: [
    'pg',
    'pg-boss',
    '@node-rs/argon2',
    '@aws-sdk/client-s3',
    '@aws-sdk/lib-storage',
    '@aws-sdk/s3-request-presigner',
    'pino',
  ],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
