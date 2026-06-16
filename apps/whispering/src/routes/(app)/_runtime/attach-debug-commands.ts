import { goto } from '$app/navigation';
import { commandCallbacks } from '$lib/commands';

export function attachDebugCommands() {
	window.commands = commandCallbacks;
	window.goto = goto;

	return () => {};
}
