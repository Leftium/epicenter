/**
 * Web stub for a Tauri-only service. See `index.tauri.ts`.
 *
 * `asShellCommand` is a pure brand-cast and would work on web, but
 * keeping it as a stub avoids dragging it into the web bundle.
 */

function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}

export const CommandError = {
	ExecuteFailed: unreachable,
} as unknown as typeof import('./index.tauri').CommandError;

export const asShellCommand =
	unreachable as unknown as typeof import('./index.tauri').asShellCommand;

export const CommandServiceLive = {
	execute: unreachable,
} as unknown as typeof import('./index.tauri').CommandServiceLive;
