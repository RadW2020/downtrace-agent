import { BadRequestError } from "./errors.ts";

/**
 * Regressions the reference app can switch on. Each one produces a distinct
 * incident shape used by benchmarks and explanation evals.
 */
export const REGRESSIONS = ["n_plus_one", "slow_dependency", "aggressive_retries", "pool_leak", "new_error"] as const;

export type Regression = (typeof REGRESSIONS)[number];

export interface RegressionParams {
  n_plus_one: Record<string, never>;
  slow_dependency: { delayMs: number };
  aggressive_retries: { timeoutMs: number; retries: number };
  pool_leak: { rate: number };
  new_error: { rate: number };
}

export type RegressionState = {
  [K in Regression]: { enabled: boolean; params: RegressionParams[K] };
};

const DEFAULTS: RegressionState = {
  n_plus_one: { enabled: false, params: {} },
  slow_dependency: { enabled: false, params: { delayMs: 3000 } },
  aggressive_retries: { enabled: false, params: { timeoutMs: 500, retries: 3 } },
  pool_leak: { enabled: false, params: { rate: 0.2 } },
  new_error: { enabled: false, params: { rate: 0.1 } },
};

/** Parameters bounded to [0, 1]; everything else is a non-negative number. */
const RATE_PARAMS = new Set(["rate"]);

export class Regressions {
  private state: RegressionState = structuredClone(DEFAULTS);

  /** Parses the REGRESSIONS env value: a comma-separated list of names. */
  static fromEnv(list: string): Regressions {
    const r = new Regressions();
    for (const raw of list.split(",")) {
      const name = raw.trim();
      if (name === "") continue;
      if (!isRegression(name)) throw new Error(`unknown regression in REGRESSIONS: "${name}"`);
      r.state[name].enabled = true;
    }
    return r;
  }

  isEnabled(name: Regression): boolean {
    return this.state[name].enabled;
  }

  params<K extends Regression>(name: K): RegressionParams[K] {
    return this.state[name].params;
  }

  enabled(): Regression[] {
    return REGRESSIONS.filter((name) => this.state[name].enabled);
  }

  snapshot(): RegressionState {
    return structuredClone(this.state);
  }

  reset(): void {
    this.state = structuredClone(DEFAULTS);
  }

  /**
   * Merges a partial patch such as
   * `{ slow_dependency: { enabled: true, params: { delayMs: 300 } } }`.
   * Unknown names or invalid parameter values are rejected with a 400.
   */
  update(patch: unknown): RegressionState {
    if (!isRecord(patch)) throw new BadRequestError("body must be an object keyed by regression name");
    for (const [name, value] of Object.entries(patch)) {
      if (!isRegression(name)) throw new BadRequestError(`unknown regression "${name}"`);
      if (!isRecord(value)) throw new BadRequestError(`"${name}" must be an object`);
      if ("enabled" in value) {
        if (typeof value.enabled !== "boolean") throw new BadRequestError(`"${name}.enabled" must be a boolean`);
        this.state[name].enabled = value.enabled;
      }
      if ("params" in value) {
        if (!isRecord(value.params)) throw new BadRequestError(`"${name}.params" must be an object`);
        const current: Record<string, number> = this.state[name].params;
        for (const [key, v] of Object.entries(value.params)) {
          if (!(key in current)) throw new BadRequestError(`"${name}.params.${key}" is not a parameter of ${name}`);
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            throw new BadRequestError(`"${name}.params.${key}" must be a non-negative number`);
          }
          if (RATE_PARAMS.has(key) && v > 1) throw new BadRequestError(`"${name}.params.${key}" must be within [0, 1]`);
          current[key] = v;
        }
      }
    }
    return this.snapshot();
  }
}

export function isRegression(name: string): name is Regression {
  return (REGRESSIONS as readonly string[]).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
