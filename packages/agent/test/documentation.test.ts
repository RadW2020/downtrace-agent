import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { guidePages } from "./support/documentation.ts";

/**
 * The README is the page npm shows, and the first thing a person or a coding agent reads; the reference lives in
 * `guide/`, beside it. The README grew to 133 KB once, a section at a time, until it was too long to be of use. These
 * hold the split: the README stays short, it leads to every page, every link from it and between the pages lands on a
 * page and a heading that exist, and none of it cites what a reader of the package cannot open.
 */

const root = new URL("../", import.meta.url);
/** Where the README links the pages from, so the links work on npm's page, which has no `guide/` beside it. */
const MIRROR = "https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/";
/** Past this the README is the reference again; what does not fit belongs in a page of `guide/`. */
const README_MAX_BYTES = 24_000;

const read = (path: string): Promise<string> => readFile(new URL(path, root), "utf8");

/** The anchor GitHub gives a heading. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    const heading = fence ? null : /^#{1,6} (.*)$/.exec(line);
    if (heading?.[1] !== undefined) anchors.add(slug(heading[1]));
  }
  return anchors;
}

/** The links of a page that point into this package, as a path from its root and an optional anchor. */
function linksIntoPackage(page: string, markdown: string): { path: string; anchor?: string }[] {
  const found: { path: string; anchor?: string }[] = [];
  for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (target === undefined) continue;
    let local: string;
    if (target.startsWith(MIRROR)) local = target.slice(MIRROR.length);
    else if (/^[a-z]+:/.test(target)) continue;
    else
      local = target.startsWith("#")
        ? `${page}${target}`
        : new URL(target, new URL(page, root)).href.slice(root.href.length);
    const [path = "", anchor] = local.split("#");
    found.push(anchor === undefined ? { path } : { path, anchor });
  }
  return found;
}

const pages = async (): Promise<string[]> => ["README.md", ...(await guidePages()).map((page) => `guide/${page}`)];

describe("the documentation", () => {
  it("keeps the README short enough to be read", async () => {
    expect(Buffer.byteLength(await read("README.md"))).toBeLessThan(README_MAX_BYTES);
  });

  it("leads from the README to every page of guide/", async () => {
    const linked = new Set(linksIntoPackage("README.md", await read("README.md")).map((link) => link.path));
    const unlinked = (await guidePages()).filter((page) => !linked.has(`guide/${page}`));
    expect(unlinked).toEqual([]);
  });

  it("links only to pages and headings that exist", async () => {
    const broken: string[] = [];
    for (const page of await pages()) {
      for (const { path, anchor } of linksIntoPackage(page, await read(page))) {
        const exists = await access(new URL(path, root)).then(
          () => true,
          () => false,
        );
        if (!exists) broken.push(`${page} → ${path}`);
        else if (anchor !== undefined && path.endsWith(".md") && !anchorsOf(await read(path)).has(anchor)) {
          broken.push(`${page} → ${path}#${anchor}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("cites nothing a reader of the package cannot open", async () => {
    // product.md and its identifiers (ERR-04), the private docs and decisions, the tickets and the issues of the
    // private repository. A `docs/` inside somebody else's URL is theirs.
    const privateReference =
      /product\.md|(?<![\w/.])docs\/|\bADR \d{4}\b|\b[A-Z]{3}-\d{2}\b|\bDT-\d+\b|\bgh-\d+\b|\binvariant \d+/g;
    const found: string[] = [];
    for (const page of await pages()) {
      for (const match of (await read(page)).match(privateReference) ?? []) found.push(`${page}: ${match}`);
    }
    expect(found).toEqual([]);
  });
});
