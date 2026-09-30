import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * A fresh application root from which `express` resolves to the Express 4 the tests run against (gh-898).
 *
 * The devDependency is the alias `express4`, and an application that uses Express 4 depends on `express`
 * by name — which is what `armMounts` resolves from the application's entry. The symlink is what a
 * `node_modules` would be in one: the same real package, by the name the application writes.
 */
export async function express4Root(): Promise<{ base: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "express4-root-"));
  const target = await realpath(createRequire(import.meta.url).resolve("express4"));
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(target, path.join(dir, "node_modules", "express"));
  return { base: dir, close: () => rm(dir, { recursive: true, force: true }) };
}
