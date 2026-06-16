/**
 * Platform seam contracts. Each `#platform/*` subpath (declared in
 * `apps/whispering/package.json` "imports") has a browser impl and a Tauri impl
 * that both conform to a type here, so the two stay in lockstep no matter which
 * one a given build or the type checker resolves. Consumers import the bare
 * `#platform/*` specifier; the build picks the impl (web uses `default`, the
 * browser file; Tauri activates the `tauri` condition).
 *
 * This file must stay free of `@tauri-apps/*` imports so it type-checks and
 * ships under the web (default) resolution.
 */

import type { Command } from '$lib/commands';

export type ShortcutBackendStatus =
	| 'idle'
	| 'attached'
	| 'unsupported'
	| 'awaitingGrant'
	| 'running'
	| 'recovering'
	| 'degraded';

/**
 * Contract for `#platform/shortcuts`: the per-platform shortcut backend. The
 * desktop build drives system-global rdev bindings (device-config storage); the
 * web build drives in-app keydown shortcuts (workspace KV storage). Only one
 * runs per platform, so consumers call these names without branching on `tauri`.
 * The trigger dispatch itself converges in `dispatchCommandTrigger`; this owns
 * the binding configuration around it.
 */
export type Shortcuts = {
	/** Reactive liveness of this platform's shortcut backend. */
	readonly status: ShortcutBackendStatus;
	/** Attach this platform's trigger backend. */
	attach(): () => void;
	/** Push every command's configured binding to this platform's backend. */
	sync(): Promise<void>;
	/** Restore every shortcut to its default binding, then re-sync. */
	reset(): void;
	/**
	 * If two commands share a binding, reset all to defaults and surface it.
	 * Returns whether a reset happened.
	 */
	resetIfDuplicates(): boolean;
	/** A command's default binding, formatted for display (`''` when unbound). */
	defaultLabel(commandId: Command['id']): string;
};

/**
 * Contract for `#platform/os`: host-OS identity, resolved once per build target.
 * The Tauri build reads the real OS natively; the web build infers it from the
 * user agent. Only the two facts the app actually branches on are exposed.
 */
export type Os = {
	/**
	 * An Apple platform: macOS, iOS, or iPadOS. These share the Command (⌘)
	 * primary modifier and the Option-key character layout, which is what every
	 * keyboard call site branches on. On the desktop (Tauri) build this is
	 * exactly macOS, since whispering's desktop targets are macOS, Windows, and
	 * Linux; iOS only ever appears on the web.
	 */
	isApple: boolean;
	/** Desktop Linux, excluding Android. Gates the Linux-only VAD notice. */
	isLinux: boolean;
};
