/**
 * The route template a Next.js request matched, read off the request itself (DT-90).
 *
 * Next keeps what it knows about a request on the Node request, under a symbol registered with
 * `Symbol.for("NextInternalRequestMeta")` — a global symbol, so the one the application's Next uses is the
 * one read here whichever copy of the module wrote it, and a `standalone` build, which ships a traced copy of
 * Next, writes the same. Among it is the match of the route table: the page or the route handler that will
 * answer, with its pathname as the file system names it, `/api/products/[id]`, never the value the request
 * carried (`match.definition.pathname`; `_nextMatch` in Next 13). The template is that pathname, as written
 * and with Next's own brackets: it is the path of the file that serves it, which is what whoever reads the
 * route needs to open.
 *
 * Next does not document this as an interface. It is read the way `routes.ts` reads Express: without calling
 * anything, without writing anything, and an object that is not the shape expected is no template. Verified
 * on Next 13.5, 14.2, 15.5 and 16.3, `next start`, `output: "standalone"`, route handlers, API routes, pages,
 * the edge runtime and a rewrite; the README says so.
 *
 * What Next did not route — an asset of `/_next/static` on some versions, a path the middleware answered —
 * carries no match, and is named by the heuristic. A path that matches nothing at all is Next's own
 * `/_not-found`, which is how Next names it, and no part of the path travels.
 */
const NEXT_REQUEST_META = Symbol.for("NextInternalRequestMeta");

/**
 * The pathname of the route Next matched for this request, or `undefined` when the request is not Next's, it
 * matched nothing, or what the match holds is not a pathname.
 *
 * A read that throws — a getter of the application's own on its request — is a request the template cannot
 * be trusted from: the heuristic names it (invariants 2 and 5).
 */
export function nextMatchedPathname(req: object): string | undefined {
  try {
    const meta = (req as Record<symbol, unknown>)[NEXT_REQUEST_META];
    if (meta === null || typeof meta !== "object") return undefined;
    const { match, _nextMatch } = meta as { match?: unknown; _nextMatch?: unknown };
    return definitionPathname(match) ?? definitionPathname(_nextMatch);
  } catch {
    return undefined;
  }
}

function definitionPathname(match: unknown): string | undefined {
  if (match === null || typeof match !== "object") return undefined;
  const definition = (match as { definition?: unknown }).definition;
  if (definition === null || typeof definition !== "object") return undefined;
  const pathname = (definition as { pathname?: unknown }).pathname;
  // A route template always begins with `/` (ADR 0104): what does not is not one.
  return typeof pathname === "string" && pathname.startsWith("/") ? pathname : undefined;
}
