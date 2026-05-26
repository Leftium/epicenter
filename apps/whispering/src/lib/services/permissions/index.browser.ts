/**
 * Web stub. Consumers (the macOS accessibility page, register-permissions)
 * dynamic-import this path; Vite needs the path to resolve at chunk-
 * generation time even though the call sites are unreachable on web
 * (`if (!window.__TAURI_INTERNALS__) return`).
 */

import { unreachable } from '$lib/services/_tauri-stub';
import type * as Tauri from './index.tauri';

export const PermissionsError = {
	CheckAccessibility: unreachable,
	RequestAccessibility: unreachable,
	CheckMicrophone: unreachable,
	RequestMicrophone: unreachable,
} satisfies typeof Tauri.PermissionsError;

export const PermissionsServiceLive = {
	accessibility: {
		check: unreachable,
		request: unreachable,
	},
	microphone: {
		check: unreachable,
		request: unreachable,
	},
} satisfies typeof Tauri.PermissionsServiceLive;
