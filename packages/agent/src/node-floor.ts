/**
 * The oldest Node.js major this package runs on: the oldest one CI consumes the packed package on. This is the one
 * place it is stated in the code.
 *
 * The package declares no `engines`, and on purpose: yarn 1 enforces it, and in a workspace whose other apps still
 * ran Node 18, adding the instrumentation to one app failed the install of all of them (DT-131). So the floor is
 * checked where the package loads instead, and a Node below it gets one warning and an instrumentation that does
 * nothing, as a missing token does.
 *
 * Imports nothing, and nothing in it needs a newer runtime than the ones it turns away: the entry points run it
 * before they load anything else.
 */
export const NODE_FLOOR = 20;

/**
 * Why the instrumentation cannot run on this Node, or undefined when it can. `version` is what
 * `process.versions.node` says: `18.20.8`. One it cannot read is turned away too: what cannot be read is not known
 * to work, and staying off is the side on which nothing breaks.
 */
export function unsupportedNode(version: string): string | undefined {
  const major = Number.parseInt(version, 10);
  if (major >= NODE_FLOOR) return undefined;
  return `Node.js ${version} is not supported: it needs Node.js ${NODE_FLOOR} or newer`;
}
