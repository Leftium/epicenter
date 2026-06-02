export {
	attachMarkdownExport,
	type ExportTableConfig,
	type ExportTablesConfig,
	type MarkdownExport,
} from './export.js';
export {
	attachGitAutosave,
	type GitAutosave,
	type GitAutosaveConfig,
} from './git-autosave.js';
export type { MarkdownShape } from './shared.js';
export {
	type ApplyPlan,
	attachMarkdownVault,
	MarkdownApplyError,
	MarkdownReadError,
	type MarkdownVault,
	type VaultTableConfig,
	type VaultTablesConfig,
} from './vault.js';
