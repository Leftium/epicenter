/**
 * isomorphic-git reads a global `Buffer` at call time. Browsers have none, so
 * the browser adapter installs the `buffer` package's implementation before
 * it first uses isomorphic-git. Bun and Node already provide one. This runs
 * when a folder is opened, never on import.
 */
import { Buffer } from 'buffer/';

export function ensureBufferGlobal() {
	const scope = globalThis as { Buffer?: unknown };
	if (scope.Buffer === undefined) scope.Buffer = Buffer;
}
