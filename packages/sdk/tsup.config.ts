import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // starknet is the only runtime dependency and must stay external so an app that
  // already installs it does not end up with two copies of the curve code.
  external: ["starknet"],
});
