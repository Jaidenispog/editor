import type { NextConfig } from 'next';

/**
 * Next.js configuration for the Studio Assistant web app.
 * Workspace packages ship TypeScript source, so they are transpiled here; native or connection-heavy
 * server libraries stay external so they load from node_modules at runtime.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
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
