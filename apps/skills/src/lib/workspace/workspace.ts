/**
 * Skills editor workspace factory — creates a workspace client from the definition.
 *
 * Returns a non-terminal builder. Consumers chain `.withExtension()` to add
 * persistence, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createSkillsEditor } from './workspace'
 *
 * const ws = createSkillsEditor()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */

import { createWorkspace } from '@epicenter/workspace';
import { skillsEditorDefinition } from './definition';


export function createSkillsEditor() {
	return createWorkspace(skillsEditorDefinition);
}
