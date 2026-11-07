import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { announcesRequires } from "../src/instrument/arm.ts";
import { guidePages } from "./support/documentation.ts";

/**
 * DT-172. Node announces what modules require, on its `module.require` channel, from 22.4.0 and not before: not on
 * 18.19, nor 20, nor 22.0 to 22.3. The code asks Node whether it announces (`announcesRequires`), and the package's
 * text said «from Node 22» and «on Node 20» where it meant before and after that release, which left a reader on
 * Node 22.0 to 22.3 with the wrong side of every passage.
 */

const root = new URL("../", import.meta.url);

/** Whether `version`, as `process.versions.node` says it, is 22.4.0 or later. */
function from224(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 4);
}

/**
 * What the package tells its readers and its maintainers: the README, the pages of `guide/`, and the comments of
 * `src/`, enumerated from disk.
 */
async function texts(): Promise<{ file: string; text: string }[]> {
  const files = [
    "README.md",
    ...(await guidePages()).map((page) => `guide/${page}`),
    ...(await readdir(new URL("src/", root), { recursive: true }))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => `src/${file}`),
  ];
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(new URL(file, root), "utf8") })));
}

/**
 * A text cut where a blank line is, a blank comment line too, and joined back into one line: a passage of a page, a
 * list item, or a comment.
 */
function passages(text: string): string[] {
  return text
    .split(/\n[ \t]*(?:\*|\/\/)?[ \t]*\n/)
    .map((passage) => passage.replace(/[ \t]*\n[ \t]*(?:\*(?!\*)|\/\/)?[ \t]*/g, " "));
}

/** A passage that speaks of modules as they load, or of the channel Node announces them on. */
const ABOUT_LOADS = (passage: string): boolean => /module\.require|\bload/i.test(passage);

/** A Node from 20 to 23 named by its major alone, which places the boundary at a major that straddles it. */
const BARE_MAJOR = /\b(?:Node|from|before|until|on) 2[0-3](?!\d|\.\d)/g;

describe("whether Node announces what modules require (RF-121)", () => {
  // covers: RF-121
  it("is what the running Node does: from 22.4, and not before", () => {
    expect(announcesRequires(createRequire(import.meta.url))).toBe(from224(process.versions.node));
  });

  // covers: RF-121
  it("is no, and throws nothing, when the require it is handed throws", () => {
    const refusing = Object.assign(
      () => {
        throw new Error("refused by the test");
      },
      { cache: {}, extensions: {}, main: undefined, resolve: () => "" },
    ) as unknown as NodeRequire;
    expect(announcesRequires(refusing)).toBe(false);
  });

  // covers: RF-121
  it("is said, in every passage of the package that names the Node it starts on, as 22.4", async () => {
    const found: string[] = [];
    for (const { file, text } of await texts()) {
      for (const passage of passages(text).filter(ABOUT_LOADS)) {
        for (const [match] of passage.matchAll(BARE_MAJOR)) found.push(`${file}: «${match}» in «${passage.trim()}»`);
      }
    }
    expect(found).toEqual([]);
  });
});
