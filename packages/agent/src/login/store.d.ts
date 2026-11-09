/**
 * Where `downtrace login` keeps the access credentials it collected, the way `gh` keeps its own: `credentials.json` in
 * the user's configuration directory, the file readable by that user alone, in a directory only they open. One entry
 * per cloud and project; a new login of the same pair replaces the earlier entry, and the others stay.
 *
 * The file is data, not configuration: a command reads it when it needs a credential, not once at start-up, so a login
 * made in another terminal is seen without starting anything again. Its path is configuration, and is read once.
 *
 * Nothing here says what a credential is in an error: a reason names the file and what is wrong with it, never what
 * it holds. Not even the parser's message, which quotes the text around where it stopped.
 */
/** The shape of the file, versioned so a reader can tell one written by a later `downtrace`. */
export declare const CREDENTIALS_SCHEMA = "downtrace.credentials/1";
/** A credential login collected, under the cloud and the project it was asked of. */
export interface StoredCredential {
    /** The cloud's URL, as login was handed it. */
    url: string;
    /** The project's slug. */
    project: string;
    /** The environment login asked for. */
    environment: string;
    /** The environments it reaches. */
    environments: string[];
    /** `read` or `operate`. */
    level: string;
    /** What the cloud names it by. */
    id: string;
    /** The secret. */
    token: string;
    /** The person who approved it. */
    onBehalfOf: string;
    /** When it stops opening anything, RFC 3339; empty when the cloud did not say, and then the cloud is the judge. */
    expiresAt: string;
}
/** How the store reaches the file, passed in and not reached for. */
export interface StoreAccess {
    /** The file: `credentialsPath` of the environment. */
    path: string;
    /**
     * The user the file must belong to. Undefined where files have no POSIX owner (Windows), and then neither the owner
     * nor the mode is checked.
     */
    uid: number | undefined;
}
/** Why the credential could not be stored. Its message names the file and never what it holds. */
export declare class CredentialStoreError extends Error {
}
/** `$XDG_CONFIG_HOME/downtrace/credentials.json`, or `~/.config/downtrace/credentials.json` without it. */
export declare function credentialsPath(env: NodeJS.ProcessEnv, home: string): string;
/**
 * Writes `entry` into the file, replacing the entry of its cloud and project. The file is written whole to a temporary
 * one beside it, created 0600 so that it is its user's alone from its first byte, and then renamed over it: a reader
 * sees the old file or the new one, never half of one. A file it cannot read is left as it is.
 */
export declare function storeCredential(entry: StoredCredential, access: StoreAccess): Promise<void>;
/** What a reader finds for a cloud and a project. */
export type StoredLookup = 
/** The credential to send. */
{
    kind: "found";
    credential: StoredCredential;
}
/** The entry is there and expired: it is not sent, and login is run again. */
 | {
    kind: "expired";
    credential: StoredCredential;
}
/** No entry for the pair; `projects` are the ones stored for the cloud. */
 | {
    kind: "missing";
    projects: string[];
}
/** No project was named and the cloud has more than one stored: these. */
 | {
    kind: "ambiguous";
    projects: string[];
}
/** The file is there and is not used: why, naming the file and not what it holds. */
 | {
    kind: "unusable";
    reason: string;
};
/**
 * The stored credential of `url` and `project`; with no project, the only one stored for `url`. The file is read on
 * every call, and a file others can read or write, of another user, or that is a symbolic link, is not used: like
 * ssh with a private key, a secret others could have read is not used as if it were still one.
 */
export declare function readStoredCredential(query: {
    url: string;
    project: string | undefined;
}, access: StoreAccess & {
    now: number;
}): Promise<StoredLookup>;
