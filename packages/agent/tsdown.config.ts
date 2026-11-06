import { defineConfig } from "tsdown";

// The library, the file `--import` loads, and the `downtrace` command, which loads neither of them, as ES modules; and
// the library again as CommonJS, for `require("@downtrace/agent")` from an instrument file on a Node that cannot
// require an ES module (before 20.19, and 22 before 22.12: DT-150). The register entry stays ES only: it awaits at
// its top level, which CommonJS cannot, and `--import` loads ES modules.
// @downtrace/protocol stays external: it is a real dependency of the published package so that its types resolve for
// TypeScript users, and it is dual too.
const common = {
  platform: "node",
  target: "node18.19",
  dts: true,
} as const;

export default defineConfig([
  {
    ...common,
    entry: ["src/index.ts", "src/register.ts", "src/cli.ts"],
    format: "esm",
    // Emit .js/.d.ts (the package is "type": "module"), matching publishConfig.exports.
    fixedExtension: false,
    clean: true,
  },
  {
    ...common,
    entry: ["src/index.ts"],
    // .cjs/.d.cts, beside the ES module build, which `clean` must then leave alone.
    format: "cjs",
    clean: false,
  },
]);
