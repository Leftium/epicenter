/**
 * Platform seam contracts. Each `#platform/*` subpath (declared in
 * `apps/fuji/package.json` "imports") has a browser impl and a Tauri impl that
 * both conform to a type here. Consumers import the bare `#platform/*` and the
 * build selects the impl: web -> `default` (browser), Tauri -> the `tauri`
 * condition. The contract keeps both impls in lockstep regardless of which one
 * a given build or the type checker resolves.
 *
 * This file must stay free of `@tauri-apps/*` imports so it type-checks under
 * the web (default) resolution.
 */

import type { createAppAuthClient } from '@epicenter/svelte/auth';

/**
 * Contract for `#platform/auth`. Identical on web and Tauri: both resolve the
 * persisted instance to the same auth client, differing only in OAuth launcher
 * (redirect vs deep-link).
 */
export type PlatformAuth = ReturnType<typeof createAppAuthClient>;

export type MarkdownFile = {
	filename: string;
	content: string;
};

/**
 * Contract for `#platform/tauri`: native capabilities backed by Tauri commands.
 * `null` on web, where the capability is absent and the consumer must guard.
 */
export type Tauri = {
	markdown: {
		directory(): Promise<string>;
		writeFiles(files: MarkdownFile[]): Promise<void>;
		readFiles(): Promise<MarkdownFile[]>;
	};
};
