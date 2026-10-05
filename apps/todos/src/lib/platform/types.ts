/**
 * The seam between the Todos UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf opens the
 * directory the desktop shell owns; the browser leaf opens a folder in
 * OPFS. Both answer the same folder handle, so the UI edits, lists, hears
 * change hints, and runs its terminal the same way in either build.
 */
import type {
	DepartureAnswerArgs,
	DepartureStatus,
} from '@epicenter/epicenter/departure';
import type { Folder, OpenFolderError } from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import type { todosDefinition } from '../definition.js';

export type TodosFolder = Folder<typeof todosDefinition>;

/**
 * The folder both leaves open. The browser names its scoped OPFS directory after
 * it; the desktop shell registers its directory under it.
 */
export const TODOS_FOLDER_ID = 'so.epicenter.todos';

/**
 * Opens the build's folder. A refusal is returned for the page to show; a
 * leaf never opens another kind of storage instead.
 */
export type OpenTodosFolder = () => Promise<
	Result<TodosFolder, OpenFolderError>
>;

/**
 * The page's side of the Epicenter host's departure wire
 * (`@epicenter/epicenter/departure`): quitting or restarting Epicenter asks
 * this page before its window ends. `#platform/departure` resolves at build
 * time; the host leaf talks to this window over Tauri, and the browser leaf
 * has no port, since nothing native ends a browser tab. A browser page never
 * guesses whether a host is there.
 */
export type DeparturePort = {
	/**
	 * Register for this window's departure nudges and focus gains, each a
	 * reason to read the status again. Resolves once registered; the returned
	 * function unregisters.
	 */
	listen(onChange: () => void, onFocus: () => void): Promise<() => void>;
	/** The host's current status for this window, read strictly. */
	status(): Promise<DepartureStatus>;
	/** Answer one round; the host returns its status after the answer. */
	answer(args: DepartureAnswerArgs): Promise<DepartureStatus>;
};
