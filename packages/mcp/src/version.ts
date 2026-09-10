/**
 * The version this server reports in its handshake.
 *
 * A constant and not a read of `package.json`: that file sits at a different depth in `src` and in `dist`,
 * and a server that cannot find its own manifest at runtime is a worse failure than a number in two places.
 * The two places are held together by a test rather than by anybody remembering.
 */
export const VERSION = "0.0.0";
