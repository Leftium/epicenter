export { createCLI } from './cli';
export { buildKvCommands } from './commands/kv-commands';
export { buildMetaCommands } from './commands/meta-commands';
export { buildTableCommands } from './commands/table-commands';
export {
	type AnyWorkspaceClient,
	hasConfig,
	resolveWorkspace,
	type WorkspaceResolution,
} from './discovery';
