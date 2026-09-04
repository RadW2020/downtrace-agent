import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  // Emit .js/.d.ts (the package is "type": "module"), matching publishConfig.exports.
  fixedExtension: false,
  platform: "node",
  target: "node20",
  dts: true,
  clean: true,
});
