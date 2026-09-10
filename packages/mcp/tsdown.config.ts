import { defineConfig } from "tsdown";

// Two entries: the library, for anyone embedding the server, and the executable a coding agent's
// configuration points at.
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  fixedExtension: false,
  platform: "node",
  target: "node20",
  dts: true,
  clean: true,
});
