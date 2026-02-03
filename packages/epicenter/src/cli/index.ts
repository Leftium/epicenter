export { createCLI } from './cli';
export {
	resolveWorkspace,
	hasConfig,
	findProjectDir,
	loadClient,
	type AnyWorkspaceClient,
	type WorkspaceResolution,
} from './discovery';
export { buildTableCommands } from './commands/table-commands';
export { buildKvCommands } from './commands/kv-commands';
export { buildMetaCommands } from './commands/meta-commands';
