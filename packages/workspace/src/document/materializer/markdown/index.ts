export type { MarkdownShape } from './shared.js';
export {
	attachGitAutosave,
	type GitAutosave,
	type GitAutosaveConfig,
} from './git-autosave.js';
export {
	attachMarkdownExport,
	type ExportTableConfig,
	type ExportTablesConfig,
	type MarkdownExport,
} from './export.js';
export {
	type ApplyPlan,
	attachMarkdownVault,
	MarkdownReadError,
	type MarkdownVault,
	MaterializerApplyError,
	type VaultTableConfig,
	type VaultTablesConfig,
} from './vault.js';
