import type { DaemonWorkspaceModule } from '../daemon/define-daemon-workspace.js';

export const PROJECT_CONFIG_FILENAME = 'epicenter.config.ts';

export type EpicenterConfig = {
	routes?: DaemonWorkspaceModule[];
};

export function defineConfig(config: EpicenterConfig): EpicenterConfig {
	return config;
}
