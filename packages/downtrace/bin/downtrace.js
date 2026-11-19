#!/usr/bin/env node
// `npx downtrace check` with nothing installed: this package depends on @downtrace/agent and runs its command. The
// command is found through the manifest, the one path of it that @downtrace/agent exports, so it is `dist/cli.js`
// published and `src/cli.ts` in the workspace. In a project that has @downtrace/agent installed, `npx downtrace`
// runs that one and never reaches this.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifest = require.resolve("@downtrace/agent/package.json");
await import(pathToFileURL(resolve(dirname(manifest), require(manifest).bin.downtrace)).href);
