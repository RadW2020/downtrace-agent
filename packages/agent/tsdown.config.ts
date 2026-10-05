import { defineConfig } from "tsdown";

// Three entries: the library, the file `--import` loads, and the `downtrace` command, which loads neither of them.
// @downtrace/protocol stays external: it is a real dependency of the published
// package so that its types resolve for TypeScript users.
export default defineConfig({
  entry: ["src/index.ts", "src/register.ts", "src/cli.ts"],
  format: "esm",
  // Emit .js/.d.ts (the package is "type": "module"), matching publishConfig.exports.
  fixedExtension: false,
  platform: "node",
  target: "node20",
  dts: true,
  clean: true,
});
