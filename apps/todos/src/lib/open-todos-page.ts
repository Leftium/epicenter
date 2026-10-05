/**
 * How the mounted page opens its Todos owner.
 *
 * Inside Epicenter, the page opens nothing until its departure answer
 * (`departure.svelte.ts`) has applied a status from the host, so no todo is
 * editable while a quit or restart may be running unknown to it. Then the
 * folder opens, and the owner is attached the moment it exists, before
 * anything is awaited, so a round that began while the folder opened fences
 * it at once. A folder that does not open is attached as no owner: a
 * departure is then answered ready. A browser page has no departure answer
 * and opens straight away.
 */
import type { OpenFolderError } from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';
import type { Departure } from './departure.svelte.js';
import type { OpenTodosFolder } from './platform/types.js';
import { createTodos, type Todos } from './todos.svelte.js';

export async function openTodosPage(
	departure: Departure | undefined,
	openFolder: OpenTodosFolder,
): Promise<Result<Todos, OpenFolderError>> {
	if (departure !== undefined) await departure.whenKnown();
	let opened: Awaited<ReturnType<OpenTodosFolder>>;
	try {
		opened = await openFolder();
	} catch (cause) {
		departure?.attach(undefined);
		throw cause;
	}
	if (opened.error) {
		// Nothing to settle: a departure is answered ready.
		departure?.attach(undefined);
		return opened;
	}
	const todos = createTodos(opened.data);
	// Before anything is awaited: a round already running fences it now.
	departure?.attach(todos);
	await todos.check();
	return Ok(todos);
}
