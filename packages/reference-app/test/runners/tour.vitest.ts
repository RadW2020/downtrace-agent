import { it } from "vitest";
import { tour } from "./tour.ts";

it("calls every route of the reference app", tour, 30_000);
