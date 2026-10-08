/** What Home may do natively, and how it knows whether it may (ADR-0189). */

import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * Whether this Home document is running inside the Epicenter desktop host.
 *
 * Synchronous on purpose: the host injects its IPC bootstrap before any module
 * runs, so the first paint already knows which pane to land on and which panes
 * can act. Home is also served to a plain browser and to a remote device
 * attached to the session, and neither can open a window or reach a
 * device-local model.
 */
export function isDesktopHost(): boolean {
	return isTauri();
}

/**
 * Reveal and focus one application's window, creating it the first time
 * (ADR-0189). Home passes an ID and nothing else; the host derives the URL and
 * window label itself.
 *
 * Pass only IDs from the list `/api/apps` served: that authenticated list is
 * the one place membership is decided (ADR-0179), and the native side checks
 * the ID's shape rather than re-deriving the catalog.
 *
 * Resolves when the window is actually open and focused, and rejects with the
 * host's own sentence when it is not, so a caller has something true to show.
 *
 * Home's verb, held by no other window. It is deliberately not the app-facing
 * `openApp(appId)` of ADR-0181, which targets an admitted catalog member only.
 */
export async function launchApplication(id: string): Promise<void> {
	await invoke('launch_application', { appId: id });
}

/**
 * Where one listed application's data stands on this device, read from the
 * folder itself. A signed-in installed app opens its account's dataset once
 * it is a Git repository here (`available`), which it becomes by an explicit
 * download or a clone; `not-downloaded` offers the download. A folder at that
 * path that is not a repository (`unclaimed`) is neither opened nor
 * downloaded over, and `message` says how to repair it by hand. Reading this
 * creates and opens nothing.
 */
export type ApplicationData =
	| { state: 'compiled' }
	| { state: 'local' }
	| { state: 'available' }
	| { state: 'not-downloaded' }
	| { state: 'unclaimed'; message: string }
	| { state: 'downloading' };

export function readApplicationData(id: string): Promise<ApplicationData> {
	return invoke<ApplicationData>('application_data', { appId: id });
}

/**
 * The line Home shows under an app's title, or `null` for none. Presence is
 * what the folder shows, never a claim about how it got here.
 */
export function applicationDataLabel(data: ApplicationData): string | null {
	switch (data.state) {
		case 'available':
			return 'Available locally';
		case 'not-downloaded':
			return "Download data to this device to open the app.";
		case 'downloading':
			return "Downloading this app's data from your account.";
		case 'unclaimed':
			return data.message;
		case 'compiled':
		case 'local':
			return null;
	}
}

/**
 * Download the signed-in account's data for one installed application, from
 * the GitHub repository it is paired with. Resolves once the folder is in
 * place; rejects with the host's own sentence otherwise. It never opens the
 * app; launch it afterward.
 */
export async function downloadApplication(id: string): Promise<void> {
	await invoke('download_application', { appId: id });
}

/** Stop a running download before anything is put in place. */
export function cancelApplicationDownload(id: string): Promise<boolean> {
	return invoke<boolean>('cancel_application_download', { appId: id });
}
