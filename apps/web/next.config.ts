import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dashboard is a client of the API, not a second copy of it — every
  // read goes over HTTP so Vercel and Render never disagree about the data.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
  },
  transpilePackages: ['@frontly/shared'],
};

export default nextConfig;
