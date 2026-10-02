import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dashboard reads files from the parent jobe repo (one level up). Allow
  // server bundles to reach across the directory boundary at runtime.
  outputFileTracingRoot: process.cwd().replace(/\/web\/?$/, ''),
  serverExternalPackages: ['mammoth'],
};

export default nextConfig;
