import {
	type AgentMessage,
	type AgentMessageStore,
	AgentMessageStoreError,
	agentMessageText,
} from '@epicenter/agent';
import { InstantString } from '@epicenter/app/field';
import type { PersistenceCapability } from '@epicenter/app/store';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { ChatHistoryData } from '../data.js';

type MessagesTable = ChatHistoryData['tables']['messages'];

export const ChatHistoryError = defineErrors({
	/** The rows are in the live document, and a restart would lose them. */
	NotSaved: () => ({
		message: "This device's storage did not save the chat history.",
	}),
	/** Storage could not be asked at all, as when its store has closed. */
	StorageThrew: ({ cause }: { cause: unknown }) => ({
		message: `This device's storage could not be asked to save the chat history: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ChatHistoryError = InferErrors<typeof ChatHistoryError>;

/**
 * Ask this device's storage to take everything the chat tables have accepted,
 * and answer with what it did.
 *
 * A table write only accepts a row into the live document. `flush` resolves
 * after a failed attempt as well as a successful one, and newer accepted work
 * can start another attempt, so the settled status is the answer. Calling this
 * again is the explicit retry: it writes nothing new to the document.
 */
export async function saveChatHistory(
	persistence: PersistenceCapability,
): Promise<Result<void, ChatHistoryError>> {
	const { data: status, error } = await tryAsync({
		try: async () => {
			do await persistence.flush();
			while (persistence.get() === 'pending');
			return persistence.get();
		},
		catch: (cause) => ChatHistoryError.StorageThrew({ cause }),
	});
	if (error !== null) return Err(error);
	return status === 'saved' ? Ok(undefined) : ChatHistoryError.NotSaved();
}

/** Present one account's one conversation to the tutor loop. */
export function createChatMessageStore(
	messages: MessagesTable,
	persistence: PersistenceCapability,
	accountKey: string,
	conversationId: string,
): AgentMessageStore {
	return {
		async set(key, value) {
			const existing = messages.rows
				.filter(
					(row) =>
						row.accountKey === accountKey &&
						row.conversationId === conversationId &&
						row.messageId === key,
				)
				.sort((left, right) => left.id.localeCompare(right.id))[0];
			// A row accepted by an earlier attempt is the same message: saving it
			// again must reach storage without adding a second row.
			if (!existing) {
				messages.create({
					accountKey,
					conversationId,
					messageId: key,
					message: value,
				});
			} else if (JSON.stringify(existing.message) !== JSON.stringify(value)) {
				const written = messages.update(existing.id, { message: value });
				if (written.error !== null) {
					return AgentMessageStoreError.WriteFailed({ cause: written.error });
				}
			}
			const { error } = await saveChatHistory(persistence);
			if (error !== null) {
				return AgentMessageStoreError.WriteFailed({ cause: error });
			}
			return Ok(undefined);
		},
		*entries() {
			const byId = new Map<string, { id: string; message: AgentMessage }>();
			for (const row of messages.rows) {
				if (
					row.accountKey !== accountKey ||
					row.conversationId !== conversationId
				)
					continue;
				const previous = byId.get(row.messageId);
				if (!previous || row.id < previous.id) {
					byId.set(row.messageId, {
						id: row.id,
						message: row.message as AgentMessage,
					});
				}
			}
			for (const [key, row] of byId) yield { key, val: row.message };
		},
		observe(handler) {
			return messages.subscribe(handler);
		},
		[Symbol.dispose]() {},
	};
}

/**
 * Accept the learner's focus as a new chat. The tutor opening waits for
 * {@link saveChatHistory} to confirm it, like every other tutor turn.
 */
export function startChat(
	chats: ChatHistoryData['tables']['chats'],
	accountKey: string,
	focus: { entryId: string; text: string }[],
) {
	if (
		focus.length < 1 ||
		focus.length > 3 ||
		focus.some((item) => !item.entryId || !item.text.trim())
	)
		throw new Error('Choose one to three saved expressions.');
	return chats.create({
		accountKey,
		focus: focus.map((item) => ({ ...item })),
		createdAt: InstantString.now(),
	});
}

/** Keep pre-redesign, message-only conversations visible without inventing focus for them. */
export function listChats(
	chats: ChatHistoryData['tables']['chats']['rows'],
	messages: MessagesTable['rows'],
	accountKey: string,
) {
	const summaries = new Map<
		string,
		{
			id: string;
			title: string;
			focus: { entryId: string; text: string }[];
			updatedAt: number;
			legacy: boolean;
		}
	>();
	const firstQuestion = new Map<string, { time: number; id: string }>();
	for (const row of chats) {
		if (row.accountKey !== accountKey) continue;
		summaries.set(row.id, {
			id: row.id,
			title: row.focus.map((item) => item.text).join(', '),
			focus: row.focus,
			updatedAt: Date.parse(row.createdAt),
			legacy: false,
		});
	}
	for (const row of messages) {
		if (row.accountKey !== accountKey) continue;
		const message = row.message as AgentMessage;
		let chat = summaries.get(row.conversationId);
		if (!chat) {
			chat = {
				id: row.conversationId,
				title: 'Earlier chat',
				focus: [],
				updatedAt: 0,
				legacy: true,
			};
			summaries.set(row.conversationId, chat);
		}
		chat.updatedAt = Math.max(chat.updatedAt, message.createdAt);
		const previous = firstQuestion.get(chat.id);
		if (
			chat.legacy &&
			message.role === 'user' &&
			(!previous ||
				message.createdAt < previous.time ||
				(message.createdAt === previous.time && row.id < previous.id))
		) {
			firstQuestion.set(chat.id, { time: message.createdAt, id: row.id });
			chat.title =
				agentMessageText(message).trim().slice(0, 60) || 'Earlier chat';
		}
	}
	return [...summaries.values()].sort(
		(a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
	);
}

export type ChatSummary = ReturnType<typeof listChats>[number];
