import { defineConfig } from "vitest/config";

// The e2e benchmarks measure latency: one file at a time, each in its own process.
export default defineConfig({ test: { fileParallelism: false } });
