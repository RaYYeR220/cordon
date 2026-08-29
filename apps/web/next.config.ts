import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every route prerenders, so the app ships as plain files. That keeps the
  // judge-facing demo hostable anywhere — GitHub Pages, any CDN, a local
  // directory — and means the URL cannot break because a serverless platform
  // is having a bad day. Nothing here needs a server: reads go straight to a
  // Starknet RPC endpoint and writes go through the user's wallet.
  output: "export",
  images: { unoptimized: true },
  // GitHub Pages serves a project site from /<repo>, so the build needs to know its
  // prefix. Empty everywhere else, which keeps `npm run dev` and any root-domain host
  // working unchanged.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  reactStrictMode: true,
  // Next writes a pair of tooling instruction files into the app directory on every dev start.
  // They are not source, they are not documentation anybody here reads, and they turn up in a
  // clean checkout as untracked noise. Off.
  agentRules: false,
  // The app is one workspace inside the repo; without this, tracing walks up
  // past the repo root looking for a lockfile.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  typescript: {
    // Never ship a build that hides type errors.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
