import { type Command, commands } from '$lib/commands';
import type { ShortcutConflict } from '$lib/platform/types';
import { keyBindingToLabel } from '$lib/utils/key-binding';

const titleOf = (id: Command['id']): string =>
	commands.find((command) => command.id === id)?.title ?? id;

/**
 * Render a {@link ShortcutConflict} to the message shown when a recorded key is
 * refused. The one place conflict prose lives: the policy layer (the backends and
 * the reach router) returns structured conflicts, and this turns them into words
 * with the catalog titles and `keyBindingToLabel` the recorder has on hand, so a
 * backend never formats a user-facing string.
 */
export function describeShortcutConflict(
	conflict: ShortcutConflict,
	isApple: boolean,
): string {
	switch (conflict.kind) {
		case 'reserved':
			return conflict.reason;
		case 'duplicate':
			return `Those keys already trigger "${titleOf(conflict.commandId)}". Pick a different combination.`;
		case 'overlap':
			return `Those keys are already part of the "${titleOf(conflict.commandId)}" gesture (${keyBindingToLabel(conflict.binding, isApple)}). Each global gesture needs its own keys, so a key used by one gesture cannot be part of another.`;
		case 'crossStore':
			return `Those keys are already used by "${titleOf(conflict.commandId)}", which also fires in this window. Pick a different combination.`;
	}
}
