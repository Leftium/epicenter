/**
 * Web stub. The macOS accessibility page dynamic-imports this path;
 * Vite needs the path to resolve at chunk-generation time even though
 * the callsite is unreachable on web (the page is Tauri-only).
 *
 * `satisfies typeof import('./index.tauri').X` gives us shape-checking
 * for free: if `index.tauri.ts` grows a new error variant or method,
 * the web build fails here instead of drifting silently.
 */

import { unreachable } from '$lib/services/_tauri-stub';
import type * as Tauri from './index.tauri';

export const CommandError = {
	ExecuteFailed: unreachable,
	SpawnFailed: unreachable,
} satisfies typeof Tauri.CommandError;

export const asShellCommand = unreachable satisfies typeof Tauri.asShellCommand;

export const CommandServiceLive = {
	execute: unreachable,
	spawn: unreachable,
} satisfies typeof Tauri.CommandServiceLive;
