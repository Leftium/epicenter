/**
 * One Whispering session: the opened workspace, the product state over it, the
 * close guard, and what the shell is showing.
 *
 * A session exists only once it has started: the folder was read and the
 * close guard is listening. Before that there is an opening, not a session,
 * and nothing answers the shell for it.
 *
 * The app layout opens exactly one session when it mounts and closes it when it
 * is destroyed. Pages receive it from context and never open a workspace, so
 * moving between `/`, `/recordings`, and `/transformations` keeps the live
 * recording, pending audio, selections, running requests, drafts, and the
 * terminal exactly as they were. Only leaving the app is guarded.
 */
import { createContext } from 'svelte';
import { Ok, type Result } from 'wellcrafted/result';
import { createLeaveGuard } from './leave.svelte.js';
import { createLibrary } from './library.svelte.js';
import { createSettingsDraft } from './settings-draft.svelte.js';
import {
	answerCloseAfterFailedOpening,
	openWorkspace,
	type Workspace,
	type WorkspaceError,
} from './workspace/index.js';

/** Why an opening ended with no session although nothing failed. */
const RELEASED = 'The layout was released before its session finished opening.';

/**
 * Build the session over an opened workspace: read the folder once, then start
 * answering the shell.
 *
 * The order is the point. The first read, and the settings file it writes on
 * a first launch, are this session's own work in the folder. Until they have
 * settled nothing may tell the shell it can close, so the close guard does
 * not exist until then: a close asked meanwhile is kept by the workspace and
 * handed to the guard the moment it starts listening, and the guard then
 * decides from a session that has finished starting.
 *
 * A session that cannot start is not returned. Its library and workspace are
 * closed first, which waits for whatever they had under way, and only then
 * does this reject. The same happens when `released` is aborted before the
 * start settles: nothing listens and nothing is left open.
 */
export async function createSession(
	workspace: Workspace,
	released?: AbortSignal,
) {
	const library = createLibrary(workspace);
	try {
		await library.start();
		if (released?.aborted) throw new Error(RELEASED);
	} catch (cause) {
		await library.close().catch(() => {});
		throw cause;
	}
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
		/**
		 * The transformation chosen for post-processing, by row path. Undefined
		 * is None, which is how a session starts. Choosing sends nothing: a
		 * transformation runs only when the person asks for it.
		 */
		postProcessing: undefined as string | undefined,
	});
	const settings = createSettingsDraft(library);
	let closing: Promise<void> | undefined;

	return {
		workspace,
		library,
		leave,
		view,
		/** The one draft of the transcription settings, wherever its form is shown. */
		settings,
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

export type Session = Awaited<ReturnType<typeof createSession>>;

/**
 * Open the workspace this page was given and start a session over it. Called
 * by the app layout when it mounts; importing this module opens nothing. A
 * workspace that cannot be opened is returned as the reason, and no session
 * exists. A session that cannot start, or whose layout was released first,
 * rejects after everything it opened has been closed.
 */
export async function openSession(
	open: () => Promise<Result<Workspace, WorkspaceError>> = openWorkspace,
	released?: AbortSignal,
): Promise<Result<Session, WorkspaceError>> {
	const opened = await open();
	if (opened.error) return opened;
	if (released?.aborted) {
		await opened.data.close().catch(() => {});
		throw new Error(RELEASED);
	}
	return Ok(await createSession(opened.data, released));
}

/**
 * What the app layout holds from mount to destroy: one opening, and the
 * release of whatever it became.
 *
 * An opening ends one of two ways, and the desktop shell's close question
 * needs an answer in both. When a session exists, its guard answers, and only
 * after looking at what the session holds. When opening failed there is no
 * session and nothing held, and the person must still be able to close the
 * window, so their close requests are answered from then on.
 *
 * While the opening is still under way nothing answers, and that lasts until
 * the session has finished starting: opening the workspace, the first read of
 * the folder, and the settings write a first launch makes. A request made in
 * that time waits, and is answered by whichever of the two the opening
 * becomes. A failed opening is answered for only once it has rejected, which
 * is after everything it opened was closed.
 *
 * `release` undoes exactly one of them: it closes the session, or stops
 * answering for the failed opening. Released before the opening settles, the
 * opening closes what it opened by itself and nothing ever answers.
 */
export function mountSession(
	open: () => Promise<Result<Workspace, WorkspaceError>> = openWorkspace,
	answerClose: () => () => void = answerCloseAfterFailedOpening,
) {
	const releasing = new AbortController();
	const opening = openSession(open, releasing.signal);
	let stopAnswering: (() => void) | undefined;
	const failed = () => {
		if (!releasing.signal.aborted) stopAnswering = answerClose();
	};
	void opening.then((opened) => {
		if (opened.error) failed();
	}, failed);
	return {
		opening,
		release() {
			if (releasing.signal.aborted) return;
			releasing.abort();
			stopAnswering?.();
			void opening.then((opened) => opened.data?.close()).catch(() => {});
		},
	};
}

/** The session of the mounted app layout. Set by the shell, read by pages. */
export const [getSession, setSession] = createContext<Session>();
