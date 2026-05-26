/**
 * Web stub. The macOS accessibility page dynamic-imports this path;
 * Vite needs the path to resolve at chunk-generation time even though
 * the callsite is unreachable on web (the page is Tauri-only).
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
