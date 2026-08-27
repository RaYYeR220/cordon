import { defineConfig } from "tsup";

const shared = {
  format: ["esm", "cjs"] as const,
  dts: true,
  sourcemap: true,
  target: "es2022" as const,
  external: ["react", "react-dom", "starknet", "@cordon/sdk"],
};

/**
 * Two builds, because the two entry points sit on opposite sides of React's server boundary.
 *
 * esbuild strips top-level directives, so `"use client"` written in the source never reaches the
 * bundle — and without it a Next App Router user importing `<ConnectWallet>` gets an error about
 * hooks in a server component, which is a miserable first five minutes with a package. The banner
 * puts it back.
 *
 * It goes on the React entry only. `@cordon/react/strk20` is UI-free on purpose: marking it as
 * client code would stop a server component reading a policy, which is exactly what that entry
 * point exists for.
 */
export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    outDir: "dist",
    clean: true,
    // Rollup's treeshaking pass, which tsup runs after esbuild, drops top-level directives — so
    // this entry skips it and lets esbuild's own dead-code elimination do the job.
    banner: { js: '"use client";' },
    // The stylesheet ships beside the bundles as `@cordon/react/styles.css`, so a host app imports
    // it once and themes it with CSS custom properties. No CSS-in-JS runtime, nothing injected.
    publicDir: "src/styles",
  },
  {
    ...shared,
    entry: { strk20: "src/strk20/index.ts" },
    outDir: "dist",
    clean: false,
    treeshake: true,
  },
]);
