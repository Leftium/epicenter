import { defineMutation, defineQuery } from '$lib/rpc/client';
import { WhisperingErr } from '$lib/result';

/**
 * Web stub for the desktop RPC namespace. The real implementation lives
 * in `index.tauri.ts` and is bundled only into Tauri builds. This file
 * exists so static imports from web-bundled consumers (settings pages
 * with Tauri-gated sections, layout utilities that no-op on web)
 * resolve at `vite build` time.
 *
 * Each leaf is a real defineQuery/defineMutation with `enabled: false`
 * and a throwing fn. TanStack never executes them because consumers
 * either gate on `window.__TAURI_INTERNALS__` or because the
 * `enabled: false` keeps the query idle. If something does manage to
 * call .execute()/.fetch() on web, the error message names this stub
 * as the source.
 *
 * Replaces the seven per-service web stubs that used to live in
 * `services/<svc>/index.browser.ts` for the Tauri-only services
 * (`autostart`, `command`, `ffmpeg`, `fs`, `global-shortcut-manager`,
 * `permissions`, `tray`). The web bundle no longer reaches into those
 * services at all because the chain from web entry to service is broken
 * here at the rpc layer.
 */

const tauriOnly = () =>
	WhisperingErr({
		title: '❌ Tauri-only RPC called from web bundle',
		description: 'This operation is only available in the desktop app.',
	});

const stubQuery = (key: readonly string[]) =>
	defineQuery({
		queryKey: key,
		queryFn: async () => tauriOnly(),
		enabled: false,
	});

const stubMutation = (key: readonly string[]) =>
	defineMutation({
		mutationKey: key,
		mutationFn: async () => tauriOnly(),
	});

export const desktopRpc = {
	autostart: {
		isEnabled: stubQuery(['autostart', 'isEnabled']),
		enable: stubMutation(['autostart', 'enable']),
		disable: stubMutation(['autostart', 'disable']),
	},
	tray: {
		setTrayIcon: stubMutation(['setTrayIcon', 'setTrayIcon']),
	},
	ffmpeg: {
		checkFfmpegInstalled: stubQuery(['ffmpeg.checkInstalled']),
	},
	globalShortcuts: {
		registerCommand: stubMutation([
			'shortcuts',
			'registerCommandGlobally',
		]),
		unregisterCommand: stubMutation([
			'shortcuts',
			'unregisterCommandGlobally',
		]),
		unregisterAll: stubMutation([
			'shortcuts',
			'unregisterAllGlobalShortcuts',
		]),
	},
} as unknown as typeof import('./index.tauri').desktopRpc;
