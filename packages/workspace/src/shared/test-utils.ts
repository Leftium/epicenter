/**
 * Test-only helpers that contain `ProjectDir` brand casts in one place.
 *
 * Production code mints `ProjectDir` exclusively via `findEpicenterDir`,
 * which validates that the path contains an `epicenter.config.ts` or
 * `.epicenter/` marker. Tests use `mkdtempSync` for fresh tmpdirs and
 * never invoke `findEpicenterDir`, so they need an explicit cast. Owning
 * the cast here keeps the brand contract honest at the call site (the
 * cast lives in a function whose name spells out "test").
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDir } from './types.js';

/**
 * Create a fresh tmp directory and return it as `ProjectDir`. The cast
 * is honest in spirit (the daemon factory will write `.epicenter/` inside
 * within the test) and contained to this helper.
 *
 * @example
 * ```ts
 * let workdir: ProjectDir;
 * beforeEach(() => { workdir = mintTestProjectDir('fuji-integration-'); });
 * ```
 */
export function mintTestProjectDir(prefix: string): ProjectDir {
	return mkdtempSync(join(tmpdir(), prefix)) as ProjectDir;
}

export class NoopWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = NoopWebSocket.CONNECTING;
	binaryType: BinaryType = 'blob';
	onopen: ((ev: Event) => unknown) | null = null;
	onclose: ((ev: CloseEvent) => unknown) | null = null;
	onerror: ((ev: Event) => unknown) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;

	constructor(
		public readonly url: string,
		_protocols?: string | string[],
	) {
		queueMicrotask(() => {
			if (this.readyState === NoopWebSocket.CLOSED) return;
			this.readyState = NoopWebSocket.OPEN;
			this.onopen?.({} as Event);
		});
	}

	send(): void {
	}

	close(): void {
		if (this.readyState === NoopWebSocket.CLOSED) return;
		this.readyState = NoopWebSocket.CLOSED;
		this.onclose?.({ code: 1005, reason: '' } as CloseEvent);
	}

	addEventListener(): void {
	}

	removeEventListener(): void {
	}
}
