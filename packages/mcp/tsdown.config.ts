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
  // The declarations are emitted from `src` alone. `tsconfig.json` takes `test` in too, for the typecheck, and a test
  // imports the instrumentation's credential writer by path: `tsgo` gave that file, outside this package, its
  // declaration beside its source, in `packages/agent/src`, and the versions PR committed it (DT-237).
  tsconfig: "tsconfig.build.json",
  clean: true,
});
