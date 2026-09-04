import pkg from "../package.json" with { type: "json" };

/** Version of this agent build, from package.json. */
export const AGENT_VERSION: string = pkg.version;
