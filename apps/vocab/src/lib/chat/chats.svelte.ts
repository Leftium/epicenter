/**
 * The chat list, read from the folder's `chats` table and from the message
 * files an earlier version saved.
 *
 * A chat is listed once its focus file is saved. Messages saved now are named
 * by their chat, so the list never reads them; the open conversation reads its
 * own. Message files from before chat prefixes are read for earlier,
 * message-only chats. The list is read when the page opens, after a chat
 * starts, and when the learner returns to the window; the latest read wins.
 */

import type { Result } from 'wellcrafted/result';
import { createAdmissions } from '../admissions.js';
import {
	type Chat,
	type FocusItem,
	readChat,
	readRows,
	type UnreadableFile,
	type VocabFolder,
} from '../data.js';
import {
	type ChatHistoryError,
	isEarlierMessage,
	listChats,
	listMessageStems,
	readMessages,
	startChat,
} from './messages.js';

export function createChatsState({
	tables,
	files,
}: Pick<VocabFolder, 'tables' | 'files'>) {
	let chats = $state.raw<Chat[]>([]);
	let earlier = $state.raw<Awaited<ReturnType<typeof readMessages>>['rows']>(
		[],
	);
	let unreadable = $state.raw<UnreadableFile[]>([]);
	let loadError = $state<string | null>(null);
	const summaries = $derived(listChats(chats, earlier));
	let sequence = 0;
	/** New chats and messages being saved; closing waits for them. */
	const admissions = createAdmissions();

	async function refresh() {
		const mine = ++sequence;
		const [
			{ data: chatListing, error: chatError },
			{ data: stems, error: stemError },
		] = await Promise.all([tables.chats.list(), listMessageStems(files)]);
		if (chatError !== null || stemError !== null) {
			if (mine === sequence)
				loadError = chatError?.message ?? stemError?.message ?? null;
			return;
		}
		const messages = await readMessages(
			tables.messages,
			stems.filter(isEarlierMessage),
		);
		if (mine !== sequence) return;
		const read = readRows(tables.chats.name, chatListing, readChat);
		chats = read.rows;
		earlier = messages.rows;
		unreadable = [...read.unreadable, ...messages.unreadable];
		loadError = null;
	}

	return {
		/** Every chat, newest first. */
		get chats() {
			return summaries;
		},
		/** Files in `chats/`, and earlier files in `messages/`, that cannot be shown. */
		get unreadable() {
			return unreadable;
		},
		/** Why the chats could not be listed at all, until a listing succeeds. */
		get loadError() {
			return loadError;
		},
		refresh,
		/** Count a chat write until it settles, so closing waits for it. */
		admit: admissions.admit,
		/** Whether a chat or message is being saved now. */
		get busy() {
			return admissions.busy;
		},
		/** Resolve once every chat and message write under way has settled. */
		close: () => admissions.quiet(),
		/** Save the focus as a new chat; it is listed once the folder holds it. */
		start: (focus: readonly FocusItem[]) =>
			admissions.admit(() => start(focus)),
	};

	async function start(
		focus: readonly FocusItem[],
	): Promise<Result<Chat, ChatHistoryError>> {
		const started = await startChat(tables.chats, focus);
		if (started.error === null) {
			// A listing already under way may not hold it.
			sequence++;
			chats = [
				...chats.filter(({ id }) => id !== started.data.id),
				started.data,
			];
			void refresh();
		}
		return started;
	}
}

export type ChatsState = ReturnType<typeof createChatsState>;
