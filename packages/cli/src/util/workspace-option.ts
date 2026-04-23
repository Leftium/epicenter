import type { Options } from 'yargs';

export const workspaceOption: Options = {
	type: 'string',
	alias: 'w',
	description:
		'Config entry name (required when epicenter.config.ts exports multiple workspaces)',
};

export function workspaceFromArgv(argv: Record<string, unknown>): string | undefined {
	return typeof argv.workspace === 'string' ? argv.workspace : undefined;
}
