/**
 * The oldest Node.js this package runs on: the oldest one CI consumes the packed package on. This is the one place it
 * is stated in the code.
 *
 * A version and not a major (DT-164, ADR 0257): Node 18 has `import.meta.resolve` without a flag and
 * `diagnostics_channel.tracingChannel` only from 18.19.0, and the package calls both. Node 19, an odd release past its
 * end of life, is promised nothing, and is turned away whole: before 19.9 it lacks `tracingChannel`, whose absence
 * ends the application at start-up, and no 19 has `import.meta.resolve` without a flag.
 *
 * The package declares no `engines`, and on purpose: yarn 1 enforces it, and in a workspace whose other apps still
 * ran Node 18, adding the instrumentation to one app failed the install of all of them (DT-131). So the floor is
 * checked where the package loads instead, and a Node below it gets one warning and an instrumentation that does
 * nothing, as a missing token does.
 *
 * Imports nothing, and nothing in it needs a newer runtime than the ones it turns away: the entry points run it
 * before they load anything else.
 */
export const NODE_FLOOR = "18.19.0";

/**
 * Why the instrumentation cannot run on this Node, or undefined when it can. `version` is what
 * `process.versions.node` says: `18.20.8`, or a pre-release such as `24.0.0-pre`, read as the release it leads to.
 * Major, minor and patch are compared as numbers, in that order. One it cannot read is turned away too: what cannot
 * be read is not known to work, and staying off is the side on which nothing breaks. `floor` is there for the tests.
 */
export function unsupportedNode(version: string, floor: string = NODE_FLOOR): string | undefined {
  const running = parts(version);
  const needed = parts(floor);
  if (running === undefined || needed === undefined || !atLeast(running, needed)) {
    return `Node.js ${version} is not supported: it needs Node.js ${floor} or newer`;
  }
  if (running[0] === 19) {
    return `Node.js ${version} is not supported: it needs Node.js ${floor} or newer, other than 19`;
  }
  return undefined;
}

type Version = readonly [number, number, number];

function parts(version: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(running: Version, floor: Version): boolean {
  for (let i = 0; i < 3; i++) {
    const have = running[i] ?? 0;
    const want = floor[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}
