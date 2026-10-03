/**
 * The browser leaf: a folder in this browser's OPFS, with a loopback Git
 * remote reached through the same-origin Vite proxy. Nothing native is
 * imported here.
 */
import { openFolder } from '@epicenter/folder/browser';
import { todosDefinition } from '../definition.js';
import { type OpenTodosFolder, TODOS_FOLDER_ID } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = () =>
	openFolder({
		id: TODOS_FOLDER_ID,
		definition: todosDefinition,
		browser: {
			author: { name: 'Todos', email: 'todos@localhost' },
			remote: { url: `${location.origin}/git/todos.git`, branch: 'main' },
		},
	});
