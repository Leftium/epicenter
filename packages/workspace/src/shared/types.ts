import type { Brand } from 'wellcrafted/brand';

/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A `fetch` with the caller's auth credential attached (bearer or session
 * cookie) and 401-refresh handled, supplied by the auth client. Same shape as
 * the global `fetch`; pass absolute URLs. Use for one-shot authed HTTP to the
 * API (e.g. a durable room sync POST) instead of attaching credentials by hand.
 */
export type AuthedFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Flatten a mapped or conditional type for IDE hover output.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Branded type for absolute filesystem paths.
 *
 * Ensures paths have been resolved to absolute paths at the type level,
 * preventing accidental use of relative paths in filesystem operations.
 */
export type AbsolutePath = string & Brand<'AbsolutePath'>;

/**
 * The Epicenter root: the folder that holds `epicenter.config.ts`.
 *
 * This is where app source and generated projections live beside the config.
 * Typically the directory where the user runs their app from (`process.cwd()`).
 * The folder name is the user's choice; nothing reserves the name `apps`.
 *
 * @example
 * ```typescript
 * const entriesDir = path.join(epicenterRoot, 'entries');
 * ```
 */
export type EpicenterRoot = AbsolutePath & Brand<'EpicenterRoot'>;
