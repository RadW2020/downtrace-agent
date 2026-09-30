// The child the `arm-at-start` test runs. It reports what the module cache held before the application
// loaded express, and whether the mount record's wrapper is in place once it does. It loads express only
// after reading the cache: loading it is the application's act, and doing it first would hide the load under
// test (gh-903).
import { createRequire } from "node:module";

// The `import-index` scenario is a process that only imports the package — a worker, a test: the import
// happens here, before the cache is read.
if (process.argv[2] === "import-index") {
  await import(new URL("../../src/index.ts", import.meta.url).href);
}

const MARK = Symbol.for("downtrace.mounts.use");
const require = createRequire(import.meta.url);
const loadedBeforeTheAppImportedAnything = Object.keys(require.cache).filter(
  (key) => key.includes("/node_modules/express/") || key.includes("/node_modules/router/"),
);
const express = require("express");
console.log(
  JSON.stringify({
    loadedBeforeTheAppImportedAnything,
    useWrapped: express.Router.prototype[MARK] === true,
  }),
);
