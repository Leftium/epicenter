import type { EventCallback } from '@tauri-apps/api/event';
import { emit, emitTo, listen } from '@tauri-apps/api/event';

/**
 * A typed channel for one window-to-window Tauri event.
 *
 * Tauri's raw `emit(name, payload)` / `listen<T>(name)` pair has no type link
 * from the event name to its payload: a listener's `T` is asserted by hand and
 * never checked against what the emitter actually sends. `defineWindowEvent`
 * declares the name and payload once and binds both `emit` and `listen` to it,
 * so emitter and listener can't drift without a compile error.
 *
 * Scope: this is for frontend-to-frontend traffic only (one webview window
 * telling another to do something). Events that cross the Rust boundary stay on
 * the generated Specta `events` (e.g. `shortcutTriggerEvent`), which are typed
 * from the Rust definitions. Don't route a window-to-window event through Rust
 * just to borrow Specta's types; Rust has no part in it.
 */
export function defineWindowEvent<T = void>(name: string) {
	// The conditional tuple makes the payload arg present exactly when there is a
	// payload: signal events (`T = void`) call `.emit()`, payload events call
	// `.emit(value)`, and passing the wrong shape is a compile error either way.
	// `[T]` keeps the conditional non-distributive, so a union payload (e.g. a
	// discriminated status) stays a single `[payload: Union]` arg instead of
	// splitting into `[a] | [b]`.
	// biome-ignore lint/suspicious/noConfusingVoidType: void is the deliberate no-payload marker for signal events.
	type Args = [T] extends [void] ? [] : [payload: T];
	return {
		name,
		emit: (...args: Args) => emit(name, args[0]),
		emitTo: (label: string, ...args: Args) => emitTo(label, name, args[0]),
		listen: (handler: EventCallback<T>) => listen<T>(name, handler),
	};
}

export type WindowEvent<T = void> = ReturnType<typeof defineWindowEvent<T>>;
