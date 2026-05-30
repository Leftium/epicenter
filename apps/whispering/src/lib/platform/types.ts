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
