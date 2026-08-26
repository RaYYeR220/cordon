import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    strk20: "src/strk20/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // The stylesheet ships beside the bundles as `@cordon/react/styles.css`, so a host app imports
  // it once and themes it with CSS custom properties. No CSS-in-JS runtime, nothing injected.
  publicDir: "src/styles",
  external: ["react", "react-dom", "starknet", "@cordon/sdk"],
});
