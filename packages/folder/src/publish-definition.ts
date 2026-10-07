/** Opening-time discovery publication through the ordinary file boundary. */
import { type DataSchema, exportSchema } from '@epicenter/definition';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { FolderFiles } from './files.js';

const log = createLogger('folder/definition');
const PublicationError = defineErrors({
	DefinitionExportFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Could not export definition.json; no publication attempted.',
		path: 'definition.json',
		cause,
	}),
	DefinitionPublicationUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: 'Publication of definition.json did not confirm a complete save.',
		path: 'definition.json',
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
		const { error: writeError } = await files.overwrite(
			'definition.json',
			text,
		);
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
