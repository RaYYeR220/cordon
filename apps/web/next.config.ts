import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The app is one workspace inside the repo; without this, tracing walks up
  // past the repo root looking for a lockfile.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  typescript: {
    // Never ship a build that hides type errors.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
