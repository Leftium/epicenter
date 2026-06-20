import { goto } from '$app/navigation';
import { commandRunners } from '$lib/commands';

export function attachDebugCommands() {
	window.commands = commandRunners;
	window.goto = goto;

	return () => {};
}
