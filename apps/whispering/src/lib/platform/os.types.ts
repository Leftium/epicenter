/**
 * Host-OS identity, resolved once per build target. The Tauri build reads the
 * real OS natively; the web build infers it from the user agent. Both impls
 * expose the same two facts, the only two the app actually branches on.
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
