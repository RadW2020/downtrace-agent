import { defineConfig } from "tsdown";

// As ES modules, and as CommonJS beside them: `@downtrace/agent`'s CommonJS build requires this package, on a Node
// that cannot require an ES module (before 20.19, and 22 before 22.12: DT-150).
const common = {
  entry: ["src/index.ts"],
  platform: "node",
  target: "node18.19",
  dts: true,
} as const;

export default defineConfig([
  // Emit .js/.d.ts (the package is "type": "module"), matching publishConfig.exports.
  { ...common, format: "esm", fixedExtension: false, clean: true },
  // .cjs/.d.cts, which `clean` must then leave alone.
  { ...common, format: "cjs", clean: false },
]);
