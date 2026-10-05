import { it } from "vitest";
import { suite } from "./backend.mjs";

it("calls its routes", () => suite("/first-report"), 30_000);
