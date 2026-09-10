import { hash64 } from "./fingerprint.ts";

/**
 * The minimal mode: no free text leaves the server.
 *
 * `product.md:104` gives the operator this as the strongest of its privacy controls, and what counts as
 * «free text» was decided by looking rather than guessing — with `DOWNTRACE_INSPECT` over the reference
 * app, every string a batch carries was listed and sorted into what the user wrote and what is ours:
 *
 * - **theirs**: the route template, the dependency target, the normalised query text, error and exception
 *   signatures, the hostname and the deployed version;
 * - **ours or Node's**: the protocol version, the agent's name and version, the runtime, the generated
 *   instance id, the HTTP method, the dependency kind, and every hash.
 *
 * What is theirs is withheld. What is ours stays, because without it there is no contract and no endpoint.
 *
 * The environment is the exception, and it is argued in ADR 0105: the ingest token already tells the cloud
 * which environment this is, so withholding it from the batch protects nothing and would collapse the
 * per-environment scope the whole product is organised by.
 */

/**
 * A name replaced by a stable digest of itself, marked so the cloud knows what it is looking at.
 *
 * The `#` is what makes it self-describing: a route template always begins with `/`, so a name beginning
 * with `#` cannot be mistaken for one (ADR 0104). And the digest is of the name, so the same route is the
 * same identity in every batch and from every process — without that the cloud could group nothing.
 */
export function withheldName(name: string): string {
  return `#${hash64(name)}`;
}
