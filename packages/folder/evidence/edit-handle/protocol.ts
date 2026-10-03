/**
 * EXPERIMENT: what the demo server and the browser facade send each other.
 *
 * Results travel as `{ data, error }`. A snapshot travels as its capture and
 * source only; the browser interprets the source itself with the table's
 * `inspect`, so a reading is never trusted from the wire.
 */
import type { GateName, GateSnapshot } from './gates.js';

/** The caller files the page shows as snippets, served from disk as they are. */
export const CALLER_SOURCES: readonly string[] = [
	'vanilla.ts',
	'SolidPanel.tsx',
	'SveltePanel.svelte',
	'immediate.ts',
	'autosave.ts',
	'main.tsx',
];

export type WireSnapshot = {
	readonly path: string;
	readonly stem: string;
	readonly sha256: string;
	readonly source: string;
};

/** An error as JSON: its name, message, and plain fields. A `cause` becomes its message. */
export type WireError = { readonly name: string; readonly message: string };

export type WireResult<TData> =
	| { readonly data: TData; readonly error: null }
	| { readonly data: null; readonly error: WireError };

/** One file as the server read it straight from disk with `node:fs`, not through the folder. */
export type DiskFile =
	| {
			readonly path: string;
			readonly state: 'text';
			readonly sha256: string;
			readonly text: string;
	  }
	| { readonly path: string; readonly state: 'missing' }
	| {
			readonly path: string;
			readonly state: 'invalidUtf8';
			readonly sha256: string;
			readonly size: number;
	  };

export type DemoEvent =
	/** The demo folder was (re)created. A page reloads when `generation` changes. */
	| {
			readonly type: 'session';
			readonly root: string;
			readonly generation: number;
	  }
	/**
	 * A change hint. `folder` came from the Bun folder's `onFilesChanged`,
	 * which hears only its own saves. `harness` is sent by the demo after
	 * another writer, because the Bun folder does not watch other programs.
	 */
	| {
			readonly type: 'hint';
			readonly paths: readonly string[];
			readonly origin: 'folder' | 'harness';
	  }
	| { readonly type: 'disk'; readonly files: readonly DiskFile[] }
	| { readonly type: 'gates'; readonly gates: GateSnapshot }
	| { readonly type: 'log'; readonly at: string; readonly text: string };

/** What the other writer changes in a row with `node:fs`. */
export type WriterChange = 'title' | 'body' | 'done';

export type HarnessRequest =
	| { readonly action: 'reset' }
	| { readonly action: 'arm'; readonly gate: GateName }
	| { readonly action: 'release' }
	| {
			readonly action: 'write';
			readonly path: string;
			readonly change: WriterChange;
	  }
	| { readonly action: 'remove'; readonly path: string }
	| { readonly action: 'corrupt'; readonly path: string }
	| { readonly action: 'hint'; readonly path: string };
