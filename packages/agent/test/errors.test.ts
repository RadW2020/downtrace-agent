import { describe, expect, it } from "vitest";
import { ErrorFingerprintCache, errorFingerprint, meaningful, sanitizeMessage, stackSignature } from "../src/errors.ts";

/**
 * `product.md:77`: «Errores y excepciones: **tipo, mensaje saneado, firma del stack**». The instrumentation
 * only ever counted them, which says how many and not which (gh-338, ADR 0083).
 */

describe("the message", () => {
  /**
   * The likeliest place in the whole product for a customer's data. Every one of these is something that has
   * ended up in an error message in a real application (invariant 5).
   */
  it("keeps nothing that looks like a value", () => {
    const cases: Array<[string, string[]]> = [
      ["user 4821 not found", ["4821"]],
      ["could not send to ana.perez@cliente.com", ["ana.perez", "cliente.com"]],
      ["order 5b6d1f0e-2c3a-4d5e-8f90-1a2b3c4d5e6f is already paid", ["5b6d1f0e"]],
      [`duplicate key value violates unique constraint "orders_email_key"`, ["orders_email_key"]],
      ["token sk_live_A1b2C3d4E5f6G7h8 rejected", ["sk_live_A1b2C3d4E5f6G7h8"]],
      ["connect ECONNREFUSED 10.0.3.14:5432", ["10.0", "5432"]],
    ];
    for (const [message, forbidden] of cases) {
      const clean = sanitizeMessage(message);
      for (const secret of forbidden) {
        expect(clean, `«${message}» kept ${secret}`).not.toContain(secret);
      }
    }
  });

  it("keeps enough to recognise the error", () => {
    expect(sanitizeMessage("user 4821 not found")).toBe("user ? not found");
    expect(sanitizeMessage("connection terminated unexpectedly")).toBe("connection terminated unexpectedly");
  });

  it("does not turn a message into a row of question marks", () => {
    // Collapsed, or a message of five values reads as noise and two different errors look the same.
    expect(sanitizeMessage("expected 1, 2, 3 got 4")).toBe("expected ? got ?");
  });
});

describe("the stack signature", () => {
  const stack = [
    "Error: nope",
    "    at findOrder (/Users/someone/dev/shop/src/orders.js:42:11)",
    "    at /Users/someone/dev/shop/src/handler.js:17:3",
    "    at Query.handleError (/Users/someone/dev/shop/node_modules/pg/lib/client.js:100:1)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n");

  it("keeps the file and the line and loses the directory", () => {
    const signature = stackSignature(stack);
    expect(signature).toContain("findOrder@orders.js:42");
    expect(signature).toContain("handler.js:17");
    // The directory gives away the `$HOME` of whoever built it and the path it was deployed to, and says
    // nothing about the error.
    expect(signature).not.toContain("/Users/");
    expect(signature).not.toContain("someone");
  });

  it("collapses a dependency to its package and Node to itself", () => {
    const signature = stackSignature(
      ["Error: nope", "    at Query.handleError (/app/node_modules/pg/lib/client.js:100:1)"].join("\n"),
    );
    expect(signature).toBe("(pg)");
    expect(stackSignature(["Error: x", "    at run (node:internal/x:1:1)"].join("\n"))).toBe("run (node)");
  });

  it("is empty when there is no stack, which is a real case and not a failure", () => {
    expect(stackSignature(undefined)).toBe("");
    expect(stackSignature("just a sentence")).toBe("");
  });
});

describe("the signature", () => {
  function thrownAt(message: string, file: string, line: number): Error {
    const err = new Error(message);
    err.stack = `Error: ${message}\n    at run (/app/src/${file}:${line}:1)`;
    return err;
  }

  it("carries the three things the product asks for", () => {
    const { text } = errorFingerprint(thrownAt("user 4821 not found", "orders.js", 42));
    expect(text).toContain("Error"); // type
    expect(text).toContain("user ? not found"); // sanitised message
    expect(text).toContain("run@orders.js:42"); // stack signature
    expect(text).not.toContain("4821");
  });

  /** The same error at the same place is one error, however the message varies. */
  it("groups two occurrences that differ only in their values", () => {
    const a = errorFingerprint(thrownAt("user 4821 not found", "orders.js", 42));
    const b = errorFingerprint(thrownAt("user 9137 not found", "orders.js", 42));
    expect(a.hash).toBe(b.hash);
  });

  /** And the same sentence from somewhere else is not the same error: the signature is about the code. */
  it("keeps two call sites apart even with the same message", () => {
    const a = errorFingerprint(thrownAt("not found", "orders.js", 42));
    const b = errorFingerprint(thrownAt("not found", "carts.js", 9));
    expect(a.hash).not.toBe(b.hash);
  });

  it("signs whatever was thrown, not only an Error", () => {
    for (const thrown of ["a string", 42, null, undefined, { message: "an object" }, ["a", "b"]]) {
      const { text, hash } = errorFingerprint(thrown);
      expect(text.length).toBeGreaterThan(0);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(errorFingerprint("boom").text).toContain("boom");
    expect(errorFingerprint({ message: "an object" }).text).toContain("an object");
  });

  it("does not invent a message for an object that has none", () => {
    // Stringifying an arbitrary object is the shortest path to shipping whatever it holds.
    const { text } = errorFingerprint({ userId: 4821, email: "ana@cliente.com" });
    expect(text).not.toContain("4821");
    expect(text).not.toContain("cliente.com");
  });
});

/**
 * `product.md:104`: «cuando algo no puede procesarse con garantías, **se omite en lugar de arriesgarse**: […]
 * un mensaje de error que no encaja en los formatos conocidos viaja solo como tipo y firma, sin texto».
 *
 * It is the only line of the document that says how the product behaves when it is not sure, and until
 * gh-343 it behaved the other way: it sent whatever survived (ADR 0084).
 */
describe("a message that says nothing after sanitising", () => {
  function signed(message: string) {
    const err = new Error(message);
    err.stack = `Error: ${message}\n    at run (/app/src/orders.js:42:1)`;
    return errorFingerprint(err);
  }

  it("does not travel", () => {
    const { text } = signed("4821 9137 5b6d1f0e-2c3a-4d5e-8f90-1a2b3c4d5e6f");
    expect(text).not.toContain("?");
    expect(text).toContain("omitted");
  });

  it("still carries the type and the signature, which is what the product asks for", () => {
    const { text } = signed("4821 9137 0x5b6d");
    expect(text).toContain("Error");
    expect(text).toContain("run@orders.js:42");
  });

  it("leaves a message that still means something alone", () => {
    expect(signed("user 4821 not found").text).toContain("user ? not found");
    expect(signed("connection terminated unexpectedly").text).toContain("connection terminated");
  });

  it("says why it is missing rather than leaving a hole", () => {
    expect(signed("4821 9137 4444").text).toContain("nothing recognisable survived");
  });

  it("still groups two omitted messages from the same place", () => {
    expect(signed("4821 9137").hash).toBe(signed("1111 2222").hash);
  });

  it("counts words and not characters", () => {
    // `?` is one character and the word it replaced was ten: counting characters would call a message
    // meaningful exactly when it lost the most.
    expect(meaningful("? ? ?")).toBe(false);
    expect(meaningful("could not connect to ?")).toBe(true);
  });
});

describe("the cache", () => {
  it("signs each distinct error once and keys on where, not on the message", () => {
    const cache = new ErrorFingerprintCache();
    const at = (message: string) => {
      const err = new Error(message);
      err.stack = `Error: ${message}\n    at run (/app/src/orders.js:42:1)`;
      return err;
    };
    cache.get(at("user 1 not found"));
    cache.get(at("user 1 not found"));
    expect(cache.misses).toBe(1);
    // A different message is a different key — the raw message is part of it — and the same signature.
    expect(cache.get(at("user 2 not found")).hash).toBe(cache.get(at("user 1 not found")).hash);
  });

  it("stops growing rather than evicting", () => {
    const cache = new ErrorFingerprintCache(2);
    for (let i = 0; i < 10; i += 1) cache.get(new Error(`distinct ${i}`));
    expect(cache.size).toBe(2);
    // And the answer is still right for the ones it did not keep.
    expect(cache.get(new Error("distinct 9")).text).toContain("distinct ?");
  });
});
