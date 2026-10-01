/**
 * One Whispering session: the opened workspace, the product state over it, the
 * close guard, and what the shell is showing.
 *
 * The app layout opens exactly one session when it mounts and closes it when it
 * is destroyed. Pages receive it from context and never open a workspace, so
 * moving between `/`, `/recordings`, and `/transformations` keeps the live
 * recording, pending audio, selections, running requests, drafts, and the
 * terminal exactly as they were. Only leaving the app is guarded.
 */
import { createContext } from 'svelte';
import { createLeaveGuard } from './leave.svelte.js';
import { createLibrary } from './library.svelte.js';
import { openWorkspace, type Workspace } from './workspace/index.js';

export function createSession(workspace: Workspace) {
	const library = createLibrary(workspace);
	const leave = createLeaveGuard(library, workspace.closing);
	/** What the shell shows. Held here so no route owns it. */
	const view = $state({
		sidebarOpen: false,
		/** The file browser beside the page, on a wide window. */
		filesPane: false,
		/** The file browser in a sheet, on a narrow window. */
		filesSheet: false,
		terminalOpen: false,
		/** The recordings filter. Rows needing repair are never filtered out. */
		recordingQuery: '',
		/** On a narrow window, whether a recording's details show in place of the list. */
		showingDetail: false,
		/** On a narrow window, whether a transformation's editor shows in place of the list. */
		showingTransformation: false,
		/** The transcription a transformation is tried on, by row path. */
		applyTo: undefined as string | undefined,
	});
	let closing: Promise<void> | undefined;

	return {
		workspace,
		library,
		leave,
		view,
		/**
		 * Whether a navigation must be held back. A navigation between this app's
		 * routes unloads nothing and is never held. One that unloads the document
		 * is held while something exists only in this window; in a browser tab
		 * that raises the browser's own leave warning.
		 */
		blocksNavigation(navigation: { readonly willUnload: boolean }): boolean {
			return navigation.willUnload && library.holdsUnsavedWork;
		},
		/** Stop answering the shell, save what can be saved, and release the folder. Runs once. */
		close(): Promise<void> {
			closing ??= (async () => {
				leave.dispose();
				await library.close();
			})();
			return closing;
		},
	};
}

export type Session = ReturnType<typeof createSession>;

/**
 * Open the workspace this page was given and read the folder once. Called by
 * the app layout when it mounts; importing this module opens nothing.
 */
export async function openSession(
	open: () => Promise<Workspace> = openWorkspace,
): Promise<Session> {
	const session = createSession(await open());
	try {
		await session.library.start();
	} catch (cause) {
		await session.close().catch(() => {});
		throw cause;
	}
	return session;
}

/** The session of the mounted app layout. Set by the shell, read by pages. */
export const [getSession, setSession] = createContext<Session>();
