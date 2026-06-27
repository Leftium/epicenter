import { openTodosBrowser } from '../../../todos.browser';
import { createTodosState } from './state.svelte';

export const todos = openTodosBrowser();
export const todosState = createTodosState(todos);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		todos[Symbol.dispose]();
	});
}
