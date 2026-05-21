import { routeSafeWorkspaceAppDocId } from '@epicenter/workspace';
import type { EntryId } from './workspace';

export const FUJI_CLOUD_APP_ID = 'fuji';
export const FUJI_ROOT_DOC_ID = 'root';

export function fujiEntryContentDocId(entryId: EntryId): string {
	return routeSafeWorkspaceAppDocId({
		prefix: 'entry',
		id: entryId,
	});
}
