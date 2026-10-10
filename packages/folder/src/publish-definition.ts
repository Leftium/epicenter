/**
 * Opening-time discovery publication through the ordinary file boundary
 * (ADR-0517): the folder's declaration, at `epicenter.json`, as JSON a tool
 * can read without running anything.
 */
import { type DataSchema, exportSchema } from '@epicenter/definition';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { FolderFiles } from './files.js';
import { DECLARATION_PATH } from './paths.js';

const log = createLogger('folder/definition');
const PublicationError = defineErrors({
	DefinitionExportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not export ${DECLARATION_PATH}; no publication attempted.`,
		path: DECLARATION_PATH,
		cause,
	}),
	DefinitionPublicationUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `Publication of ${DECLARATION_PATH} did not confirm a complete save.`,
		path: DECLARATION_PATH,
		cause,
	}),
});

/** Await one create-or-replace attempt; a discovery failure never refuses opening. */
export async function publishDefinition(
	prepared: DataSchema,
	files: Pick<FolderFiles, 'overwrite'>,
): Promise<void> {
	try {
		const { data: text, error: exportError } = exportSchema(prepared);
		if (exportError !== null) {
			log.error(
				PublicationError.DefinitionExportFailed({ cause: exportError }),
			);
			return;
		}
		const { error: writeError } = await files.overwrite(DECLARATION_PATH, text);
		if (writeError !== null)
			log.error(
				PublicationError.DefinitionPublicationUnconfirmed({
					cause: writeError,
				}),
			);
	} catch (cause) {
		// A thrown write can also have landed. Retain the cause without claiming
		// the destination is missing, unchanged, or successfully published.
		log.error(PublicationError.DefinitionPublicationUnconfirmed({ cause }));
	}
}
