import { it } from "node:test";
import { suite } from "./backend.mjs";

it("calls its routes", { timeout: 30_000 }, () => suite("/first-report"));
