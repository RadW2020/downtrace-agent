import { readdir, readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

/** The reference pages beside the README, by file name, sorted. */
export async function guidePages(): Promise<string[]> {
  return (await readdir(new URL("guide/", root))).filter((file) => file.endsWith(".md")).sort();
}

/**
 * What this package tells its readers: the README, which is the page npm shows, and the reference pages in `guide/`
 * it links to. A fact that moved from one to the other is still said, so a test that holds the documentation to the
 * source reads all of it.
 */
export async function readDocumentation(): Promise<string> {
  const pages = await guidePages();
  const texts = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    ...pages.map((page) => readFile(new URL(`guide/${page}`, root), "utf8")),
  ]);
  return texts.join("\n");
}
