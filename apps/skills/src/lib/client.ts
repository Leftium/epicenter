import { createSkillsWorkspace } from '@epicenter/skills';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';

const { workspace: base, instructionsDocs, referenceDocs } =
	createSkillsWorkspace();

export const workspace = base.withExtension('persistence', indexeddbPersistence);
export { instructionsDocs, referenceDocs };
