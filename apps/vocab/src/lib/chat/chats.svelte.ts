/**
 * The chat list, read from the folder's `chats` and `messages` tables.
 *
 * A chat is listed once its focus file has a receipt. Message files are read
 * for each chat's latest activity and for earlier, message-only chats; the
 * open conversation reads its own transcript.
 */

import type { Result } from 'wellcrafted/result';
import {
	type Chat,
	type ChatMessage,
	type FocusItem,
	readChat,
	readMessage,
	readRows,
	type UnreadableFile,
	type VocabTables,
} from '../data.js';
import { createReread } from '../reread.js';
import { type ChatHistoryError, listChats, startChat } from './messages.js';

export function createChatsState({
	tables,
}: {
	tables: Pick<VocabTables, 'chats' | 'messages'>;
}) {
	let chats = $state.raw<Chat[]>([]);
	let messages = $state.raw<ChatMessage[]>([]);
	let unreadable = $state.raw<UnreadableFile[]>([]);
	let loadError = $state<string | null>(null);
	const summaries = $derived(listChats(chats, messages));
	// Counts new-chat receipts. A listing asked for before one may not hold
	// that chat, so it is not applied and the folder is read again.
	let receipts = 0;

	const refresh = createReread(async () => {
		const before = receipts;
		const [
			{ data: chatListing, error: chatListError },
			{ data: messageListing, error: messageListError },
		] = await Promise.all([tables.chats.list(), tables.messages.list()]);
		if (before !== receipts) return false;
		if (chatListError !== null) {
			loadError = chatListError.message;
			return true;
		}
		if (messageListError !== null) {
			loadError = messageListError.message;
			return true;
		}
		const readChats = readRows(chatListing, readChat);
		const readMessages = readRows(messageListing, readMessage);
		chats = readChats.rows;
		messages = readMessages.rows;
		unreadable = [...readChats.unreadable, ...readMessages.unreadable];
		loadError = null;
		return true;
	});

	return {
		/** Every chat, newest activity first. */
		get chats() {
			return summaries;
		},
		/** Row files in `chats/` and `messages/` that cannot be shown. */
		get unreadable() {
			return unreadable;
		},
		/** Why the chats could not be listed at all, until a listing succeeds. */
		get loadError() {
			return loadError;
		},
		refresh,
		/** Save the focus as a new chat; it is listed once the folder holds it. */
		async start(
			focus: readonly FocusItem[],
		): Promise<Result<Chat, ChatHistoryError>> {
			const started = await startChat(tables.chats, focus);
			const { data: chat, error: startError } = started;
			if (startError === null) {
				receipts++;
				chats = [...chats, chat];
			}
			return started;
		},
	};
}

export type ChatsState = ReturnType<typeof createChatsState>;
