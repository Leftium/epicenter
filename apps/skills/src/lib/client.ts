import { createSkillsWorkspace } from '@epicenter/skills';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';

export const workspace = createSkillsWorkspace().withExtension('persistence', indexeddbPersistence);
