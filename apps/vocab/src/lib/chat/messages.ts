import {
	type AgentMessage,
	type AgentMessageStore,
	AgentMessageStoreError,
	agentMessageText,
} from '@epicenter/agent';
import { InstantString } from '@epicenter/app/field';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type Chat,
	type ChatMessage,
	type FocusItem,
	readMessage,
	type UnreadableFile,
	type VocabTables,
} from '../data.js';

export const ChatHistoryError = defineErrors({
	/** The folder could not list the messages, so the transcript is unknown. */
	NotRead: ({ cause }: { cause: unknown }) => ({
		message: `This chat could not be read: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The folder did not confirm the new chat's file. */
	NotSaved: ({ cause }: { cause: unknown }) => ({
		message: `This chat was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
	InvalidFocus: () => ({ message: 'Choose one to three saved expressions.' }),
	/** A different message already has this file. Nothing was written. */
	Taken: ({ path }: { path: string }) => ({
		message: `Another message is already saved at '${path}'.`,
		path,
	}),
});
export type ChatHistoryError = InferErrors<typeof ChatHistoryError>;

/**
 * One chat's finished messages, presented to the tutor loop.
 *
 * `entries` is what the folder has answered for: the messages of the latest
 * listing, and each message whose file receipt arrived after that listing
 * was asked for. A listing delivered late never removes such a message. `set` resolves
 * `Ok` only on that receipt, so the loop asks the tutor nothing before a
 * learner message is a file, and an answer is a phrase source only once it is.
 *
 * A message's file is `messages/<message id>.md`. Creation is exclusive, so
 * saving a message again after an unconfirmed attempt finds its own file and
 * adds no second one, and a different message at that name is refused.
 */
export function createChatMessageStore(
	table: VocabTables['messages'],
	chatId: string,
): AgentMessageStore & {
	/** Message files of this chat that cannot be shown or sent to the tutor. */
	readonly unreadable: UnreadableFile[];
	/**
	 * Read this chat's messages from the folder. Until the first read
	 * answers, the store is empty; a failed read leaves what it had.
	 */
	load(): Promise<Result<void, ChatHistoryError>>;
} {
	let saved = new Map<string, AgentMessage>();
	let unreadable: UnreadableFile[] = [];
	// A listing describes the folder at some moment before it is delivered. It
	// never replaces a newer listing, and never removes a message whose
	// receipt arrived after it was asked for.
	let loads = 0;
	let receipts = 0;
	const receivedAt = new Map<string, number>();
	const handlers = new Set<() => void>();
	const notify = () => {
		for (const handler of handlers) handler();
	};

	return {
		get unreadable() {
			return unreadable;
		},
		async load() {
			const mine = ++loads;
			const receiptsBefore = receipts;
			const listed = await table.list();
			if (listed.error !== null)
				return ChatHistoryError.NotRead({ cause: listed.error });
			// A later load was asked for; its listing is the one to show.
			if (mine !== loads) return Ok(undefined);
			const next = new Map<string, { stem: string; message: AgentMessage }>();
			const problems: UnreadableFile[] = [];
			for (const { path, result } of listed.data) {
				// A file that names no chat, because it could not be read or its
				// text does not parse, is reported by the folder-wide list.
				if (result.error !== null || result.data.fields.chat !== chatId)
					continue;
				const row = readMessage(result.data);
				if (!row) {
					problems.push({
						path,
						reason: result.data.issues.map((issue) => issue.message).join('; '),
					});
					continue;
				}
				// Two files can hold one message id; the lowest stem is shown.
				const previous = next.get(row.message.id);
				if (!previous || row.stem < previous.stem)
					next.set(row.message.id, row);
			}
			const listing = new Map([...next].map(([id, row]) => [id, row.message]));
			for (const [key, at] of receivedAt) {
				const kept = saved.get(key);
				if (at > receiptsBefore && kept && !listing.has(key))
					listing.set(key, kept);
			}
			saved = listing;
			unreadable = problems;
			notify();
			return Ok(undefined);
		},
		async set(key, value) {
			const fields = { chat: chatId, message: value };
			const created = await table.create({ stem: key, fields });
			if (created.error !== null) {
				if (created.error.name !== 'Exists')
					return AgentMessageStoreError.WriteFailed({ cause: created.error });
				// An earlier attempt may have landed without its receipt.
				const current = await table.get(key);
				if (current.error !== null)
					return AgentMessageStoreError.WriteFailed({ cause: current.error });
				const held = current.data && readMessage(current.data);
				if (
					!held ||
					held.chat !== chatId ||
					JSON.stringify(held.message) !== JSON.stringify(value)
				)
					return AgentMessageStoreError.WriteFailed({
						cause: ChatHistoryError.Taken({ path: created.error.path }).error,
					});
			}
			saved.set(key, value);
			receivedAt.set(key, ++receipts);
			notify();
			return Ok(undefined);
		},
		*entries() {
			for (const [key, val] of saved) yield { key, val };
		},
		observe(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		[Symbol.dispose]() {
			handlers.clear();
		},
	};
}

/**
 * Save the learner's focus as a new chat and answer with its ID once the
 * folder holds the file. The tutor opening is requested only after that.
 */
export async function startChat(
	chats: VocabTables['chats'],
	focus: readonly FocusItem[],
): Promise<Result<Chat, ChatHistoryError>> {
	if (
		focus.length < 1 ||
		focus.length > 3 ||
		focus.some((item) => !item.entryId || !item.text.trim())
	)
		return ChatHistoryError.InvalidFocus();
	const chat = {
		createdAt: InstantString.now(),
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
	const created = await chats.create({ fields: chat });
	if (created.error !== null)
		return ChatHistoryError.NotSaved({ cause: created.error });
	return Ok({ id: created.data.stem, ...chat });
}

/**
 * Every chat, newest activity first. A chat is a `chats` row; messages whose
 * chat has no row are an earlier, message-only chat, shown with its first
 * learner question as the title and no focus invented for it.
 */
export function listChats(
	chats: readonly Chat[],
	messages: readonly ChatMessage[],
) {
	const summaries = new Map<
		string,
		{
			id: string;
			title: string;
			focus: FocusItem[];
			updatedAt: number;
			legacy: boolean;
		}
	>();
	const firstQuestion = new Map<string, { time: number; stem: string }>();
	for (const row of chats) {
		summaries.set(row.id, {
			id: row.id,
			title: row.focus.map((item) => item.text).join(', '),
			focus: row.focus,
			updatedAt: Date.parse(row.createdAt),
			legacy: false,
		});
	}
	for (const { stem, chat: chatId, message } of messages) {
		let chat = summaries.get(chatId);
		if (!chat) {
			chat = {
				id: chatId,
				title: 'Earlier chat',
				focus: [],
				updatedAt: 0,
				legacy: true,
			};
			summaries.set(chatId, chat);
		}
		chat.updatedAt = Math.max(chat.updatedAt, message.createdAt);
		const previous = firstQuestion.get(chat.id);
		if (
			chat.legacy &&
			message.role === 'user' &&
			(!previous ||
				message.createdAt < previous.time ||
				(message.createdAt === previous.time && stem < previous.stem))
		) {
			firstQuestion.set(chat.id, { time: message.createdAt, stem });
			chat.title =
				agentMessageText(message).trim().slice(0, 60) || 'Earlier chat';
		}
	}
	return [...summaries.values()].sort(
		(a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
	);
}
