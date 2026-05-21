import { routeSafeWorkspaceAppDocId } from '@epicenter/workspace';
import type { NoteId } from './workspace';

export const HONEYCRISP_CLOUD_APP_ID = 'honeycrisp';
export const HONEYCRISP_ROOT_DOC_ID = 'root';

export function honeycrispNoteBodyDocId(noteId: NoteId): string {
	return routeSafeWorkspaceAppDocId({
		prefix: 'note',
		id: noteId,
	});
}
