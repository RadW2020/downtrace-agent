import { it } from "node:test";
import { tour } from "./tour.ts";

it("calls every route of the reference app", { timeout: 30_000 }, tour);
