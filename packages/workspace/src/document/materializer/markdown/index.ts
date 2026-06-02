export type { GitAutosaveConfig, MarkdownShape } from './shared.js';
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
