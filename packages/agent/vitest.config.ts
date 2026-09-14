import { configDefaults, defineConfig } from "vitest/config";

/**
 * The fast suite does not run the tests that **measure**; `make bench-measure` does and CI does not run them
 * at all.
 *
 * ADR 0032 took the benchmark out of the pipeline because that machine cannot measure — the two runners live
 * on the same VM — and ADR 0114 drew the line for everything after it: «la línea no es rápido o lento, ni
 * unitario o de integración: es de qué habla la aserción». A test that compares an elapsed time against a
 * number talks about the machine, so it runs where the number means something.
 *
 * The mechanism is the file's name, which is the one ADR 0114 chose. It lived only in `packages/bench` until
 * an assertion in this package failed under load for exactly the reason that ADR describes (gh-562).
 *
 * `DOWNTRACE_MEASURE` is what the `test:measure` script sets, and it means «this run asked for them» — the
 * same part `DOWNTRACE_REQUIRE_DB` plays in the sibling config. The name differs because the thing being
 * asked for differs: there the measuring tests need a database, and here they need nothing but a quiet CPU.
 */
const askedForMeasurements = process.env.DOWNTRACE_MEASURE === "1";

export default defineConfig({
  test: {
    exclude: askedForMeasurements ? configDefaults.exclude : [...configDefaults.exclude, "**/*measure*.test.ts"],
  },
});
