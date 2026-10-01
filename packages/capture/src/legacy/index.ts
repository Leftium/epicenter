/**
 * `@epicenter/capture/legacy`: reading the old Personal store and importing
 * it as Markdown. Migration and recovery only; the running app's file model
 * is the package root.
 */
export {
	accountTagOf,
	BUNDLE_FORMAT,
	bundleIdOf,
	exportLegacyBundle,
	type LegacyAccount,
	type LegacyBundle,
	type LegacyReader,
	readLegacyBundle,
	serializeLegacyBundle,
} from './bundle.js';
export { legacyCaptureDefinition } from './definition.js';
export {
	type DocumentOutcome,
	type ImportDiagnostics,
	type ImportFiles,
	type ImportPlan,
	type ImportReceipt,
	type ImportReport,
	type PlannedDocument,
	planLegacyImport,
	RECOVERY_DIRECTORY,
	runLegacyImport,
} from './import.js';
