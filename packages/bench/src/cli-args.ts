/**
 * The flags of a campaign, ready for `parseArgs` (gh-853).
 *
 * pnpm forwards the literal `--` of `pnpm run <campaign> -- <flags>` to the script, and to `parseArgs` a
 * leading `--` is the separator that demotes every flag after it to a positional: with `allowPositionals: true`
 * the campaigns then ran on their defaults without a word, their reports proudly stating the defaults. Strip
 * the one forwarded `--` so a campaign parses the same flags with or without it; a second `--` is left in
 * place, where `parseArgs` with `allowPositionals: false` refuses it as a positional.
 */
export function cliArgs(args: readonly string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}
