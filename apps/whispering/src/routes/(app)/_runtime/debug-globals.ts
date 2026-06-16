/**
 * Owns debug globals exposed on the main window for command and navigation
 * experiments during local development.
 */

import { goto } from '$app/navigation';
import { commandCallbacks } from '$lib/commands';

export const debugGlobalsRuntime = {
	attach() {
		window.commands = commandCallbacks;
		window.goto = goto;
	},
};
