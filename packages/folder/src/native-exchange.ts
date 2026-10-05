/**
 * Atomic exchange of two existing files, for replacements in a Bun directory
 * folder (`native-store.ts`).
 *
 * `exchangeFiles(a, b)` swaps the two directory entries in one system call:
 * `renamex_np(RENAME_SWAP)` on macOS, `renameat2(RENAME_EXCHANGE)` on Linux.
 * Both paths must exist at that moment. When either is missing the call
 * fails with `ENOENT` and nothing changes, so a replacement can never create
 * the file it replaces. A filesystem that cannot exchange fails with its own
 * errno (`ENOTSUP`, `EINVAL`, `ENOSYS`); there is no rename fallback.
 *
 * Bun has no exchange of its own and `bun:ffi` is experimental, so the call
 * is a small Node-API addon, `addon/exchange.c`. This module only loads it:
 * `scripts/build-addon.ts` (`bun run build:addon`) compiles it beforehand to
 * `exchangeArtifact()`, a name that carries the source's hash, the platform,
 * and the architecture. A missing or stale build fails the exchange before
 * anything is written, with the command that prepares it. A source that
 * cannot be read or a build that cannot be loaded fails the same way with
 * its actual cause instead. These loading failures carry no `code`, so they
 * are never mistaken for the exchange's own errno. The next exchange looks
 * again, so a process can retry once the cause is fixed; only a successful
 * load is kept. Only `@epicenter/folder/bun` reaches this module, so a
 * browser build never loads the addon.
 *
 * Windows and other platforms have no addon: `exchangeFiles` rejects there
 * with a plain `Error` naming the platform, before touching either path, so
 * a replacement is unavailable rather than published some other way.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADDON = fileURLToPath(new URL('../addon/', import.meta.url));
/** The addon's C source. */
export const EXCHANGE_SOURCE = join(ADDON, 'exchange.c');
const SYSCALL = process.platform === 'darwin' ? 'renamex_np' : 'renameat2';
const PREPARE = 'bun run --filter @epicenter/folder build:addon';

/** The platforms `addon/exchange.c` compiles for. */
export const exchangeSupported =
	process.platform === 'darwin' || process.platform === 'linux';

/** Built addons of this platform and architecture, whatever their source. */
const artifactPrefix = () => `exchange-${process.platform}-${process.arch}-`;

/** Where the addon built from the current source belongs. */
export function exchangeArtifact(): string {
	const digest = createHash('sha256')
		.update(readFileSync(EXCHANGE_SOURCE))
		.digest('hex')
		.slice(0, 16);
	return join(ADDON, 'build', `${artifactPrefix()}${digest}.node`);
}

type Addon = { exchange(a: string, b: string): number };
let loaded: Addon | undefined;

/**
 * Why the addon cannot be used, as a plain `Error` with no `code`: a caller
 * that reads `code` as the exchange's errno must never take a loading
 * failure (an `ENOENT` for a missing source, say) for a missing file. The
 * original failure is the `cause`, and its message is kept.
 */
function unavailable(reason: string, cause: unknown): Error {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return new Error(
		`The folder's file exchange addon is unavailable: ${reason}: ${detail}`,
		{ cause },
	);
}

/**
 * Find and load the prepared addon. Every failure is a plain `Error` with no
 * `code`. Only a missing or stale build names the command that prepares it;
 * a source that cannot be read or a build that cannot be loaded carries its
 * actual cause, which rebuilding may not cure.
 */
function load(): Addon {
	if (!exchangeSupported)
		throw new Error(
			`Replace-existing publication is not available on ${process.platform}. Nothing was written to the destination.`,
		);
	let artifact: string;
	try {
		artifact = exchangeArtifact();
	} catch (cause) {
		throw unavailable(
			`its source '${EXCHANGE_SOURCE}' could not be read to identify its build`,
			cause,
		);
	}
	if (!existsSync(artifact)) {
		let stale: boolean;
		try {
			stale =
				existsSync(join(ADDON, 'build')) &&
				readdirSync(join(ADDON, 'build')).some((name) =>
					name.startsWith(artifactPrefix()),
				);
		} catch (cause) {
			throw unavailable(`its build directory could not be listed`, cause);
		}
		throw new Error(
			`The folder's file exchange addon is ${stale ? 'stale' : 'not built'} for ${process.platform}-${process.arch}: '${artifact}' is missing. Run '${PREPARE}', then retry.`,
		);
	}
	try {
		const module = { exports: {} as Addon };
		process.dlopen(module, artifact);
		return module.exports;
	} catch (cause) {
		throw unavailable(`'${artifact}' could not be loaded`, cause);
	}
}

/** The loaded addon. Only a successful load is kept; a failed one is tried again. */
function addon(): Addon {
	loaded ??= load();
	return loaded;
}

const errnoNames = new Map(
	Object.entries(constants.errno).map(([name, value]) => [value, name]),
);

/**
 * Swap the entries at `a` and `b`, both of which must exist. A refusal rejects
 * with an error shaped like Node's: `code` (`ENOENT` when either is missing),
 * `errno`, `syscall`, `path`, and `dest`. An addon that cannot be used
 * rejects with a plain `Error` and no `code` (see `load`): a missing or stale
 * build names the command that prepares it, and any other loading failure
 * carries its cause. A path the addon refuses, such as one with a NUL
 * character, rejects with its `TypeError`. In every rejection but the
 * exchange's own errno, nothing was exchanged. The system call itself runs
 * synchronously.
 */
export async function exchangeFiles(a: string, b: string): Promise<void> {
	const errno = addon().exchange(a, b);
	if (errno === 0) return;
	const code = errnoNames.get(errno) ?? `errno ${errno}`;
	throw Object.assign(
		new Error(`${code}: ${SYSCALL} could not exchange '${a}' and '${b}'`),
		{ code, errno, syscall: SYSCALL, path: a, dest: b },
	);
}
