import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@swarm-explorer/api-client', '@swarm-explorer/ui', '@swarm-explorer/core', '@swarm-explorer/db', '@swarm-explorer/schema', '@swarm-explorer/node-core'],
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        // Public, credential-free catalog reads (SPEC 13.1). The desktop client calls the
        // API from its main process, so bearer endpoints never need browser CORS.
        source: '/v1/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET' },
        ],
      },
    ];
  },
};

export default config;
