/** @type {import('next').NextConfig} */
const API = process.env.API_URL ?? 'http://localhost:4000';
export default {
  reactStrictMode: true,
  output: 'standalone',
  poweredByHeader: false,
  async rewrites() {
    // Same-origin API access so the httpOnly refresh cookie (path /v1/auth) works without CORS.
    return [{ source: '/v1/:path*', destination: `${API}/v1/:path*` }, { source: '/graphql', destination: `${API}/graphql` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), display-capture=(self), geolocation=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    ] }];
  },
};
