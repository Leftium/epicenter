import type { DaemonWorkspaceDefinition } from '../daemon/define-daemon-workspace.js';

export const PROJECT_CONFIG_FILENAME = 'epicenter.config.ts';
export const DEFAULT_PROJECT_CONFIG_SOURCE = `import { defineConfig } from '@epicenter/workspace';

export default defineConfig({});
`;

export type EpicenterConfig = {
	daemon?: {
		routes?: Record<string, DaemonWorkspaceDefinition>;
	};
};

export function defineConfig(config: EpicenterConfig): EpicenterConfig {
	return config;
}
