/**
 * Copying what the earlier, account-based Vocab saved into the folder.
 *
 * Earlier Vocab kept words in an account's Personal store and chats in a
 * device store whose rows carry an account key. Neither is the folder, and
 * nothing promotes them automatically: a person asks for this copy.
 *
 * The copy only creates files. Each old row becomes the file named by its old
 * row ID, so the copy can be repeated: a row whose own copy exists is left
 * exactly as the folder has it, including a note or stage edited since, and
 * a focus still names its word. A file at that name that is not the row's
 * copy is another file: it is left alone and the row is reported as not
 * copied. Two old words with the same text are two files, each with its own
 * note and stage. This copy writes no row to the old stores and deletes
 * nothing from them.
 */
import type { AgentMessage } from '@epicenter/agent';
import {
	defineStore,
	defineTable,
	field,
	jsonValue,
	type RowOf,
} from '@epicenter/app';
import { APPS } from '@epicenter/constants/apps';
import { Type } from 'typebox';
import { extractErrorMessage } from 'wellcrafted/error';
import type { VocabTables } from './data.js';

const legacyEntriesTable = defineTable({
	fields: {
		text: field.string(),
		note: field.string(),
		stage: field.select(['new', 'recognized', 'understood', 'usable']),
		createdAt: field.instant(),
	},
});
const legacyMessagesTable = defineTable({
	fields: {
		accountKey: field.string(),
		conversationId: field.string(),
		messageId: field.string(),
		message: field.json(jsonValue),
	},
});
const legacyChatsTable = defineTable({
	fields: {
		accountKey: field.string(),
		createdAt: field.instant(),
		focus: field.json(
			Type.Array(Type.Object({ entryId: Type.String(), text: Type.String() }), {
				minItems: 1,
				maxItems: 3,
			}),
		),
	},
});

/** The earlier device store: chats and messages, each row under an account key. */
export const legacyChatHistoryDefinition = defineStore({
	id: APPS.VOCAB.id,
	title: 'Vocab chats on this device',
	kv: {},
	tables: { messages: legacyMessagesTable, chats: legacyChatsTable },
});

/** The earlier Personal store: one account's words. */
export const legacyVocabDefinition = defineStore({
	id: APPS.VOCAB.id,
	title: 'Vocab',
	kv: {},
	tables: { entries: legacyEntriesTable },
});

/** What one account saved in the earlier stores, as this device holds it. */
export type LegacyRows = {
	entries: readonly RowOf<typeof legacyEntriesTable>[];
	chats: readonly RowOf<typeof legacyChatsTable>[];
	messages: readonly RowOf<typeof legacyMessagesTable>[];
};

export type ImportCount = {
	/** Files this run created. */
	copied: number;
	/** Rows whose file was already in the folder, left as the folder has it. */
	alreadyHere: number;
	/** Rows the folder refused, each with why. Nothing was written for them. */
	failed: { id: string; reason: string }[];
};
export type ImportReport = {
	words: ImportCount;
	chats: ImportCount;
	messages: ImportCount;
};

/**
 * Copy rows through one table. A file already at a row's name counts as that
 * row's earlier copy only when it reads as the same row; anything else there
 * is another file, which is left as it is and reported, with the old row
 * still in the earlier storage.
 */
async function copyRows<TRow extends { id: string }, TFields>(
	rows: readonly TRow[],
	table: {
		create(input: {
			stem: string;
			fields: TFields;
		}): Promise<{ error: { name: string; message: string } | null }>;
		get(stem: string): Promise<{
			data: { path: string; fields: object } | null | undefined;
			error: { message: string } | null;
		}>;
	},
	fieldsOf: (row: TRow) => TFields,
	/** The fields that say which row a file is. A note or stage is not one. */
	identityOf: (fields: Partial<TFields>) => unknown,
	/**
	 * Why this row must not be copied because of what it refers to, asked
	 * before anything is written for it. Its own copy from an earlier run
	 * passed the same question then, and the answer is asked again each run.
	 */
	refusal: (row: TRow) => Promise<string | undefined> = async () => undefined,
): Promise<ImportCount & { settled: Set<string> }> {
	const count = {
		copied: 0,
		alreadyHere: 0,
		failed: [] as ImportCount['failed'],
		/** Rows whose own copy is in the folder after this run. */
		settled: new Set<string>(),
	};
	for (const row of rows) {
		const refused = await refusal(row);
		if (refused !== undefined) {
			count.failed.push({ id: row.id, reason: refused });
			continue;
		}
		const fields = fieldsOf(row);
		const { error } = await table.create({ stem: row.id, fields });
		if (error === null) {
			count.copied++;
			count.settled.add(row.id);
			continue;
		}
		let reason = extractErrorMessage(error);
		if (error.name === 'Exists') {
			const current = await table.get(row.id);
			if (
				current.data &&
				JSON.stringify(identityOf(current.data.fields)) ===
					JSON.stringify(identityOf(fields))
			) {
				count.alreadyHere++;
				count.settled.add(row.id);
				continue;
			}
			reason = current.error
				? current.error.message
				: `A different file is already saved at '${current.data?.path ?? row.id}'. It was left as it is.`;
		}
		count.failed.push({ id: row.id, reason });
	}
	return count;
}

const count = ({ copied, alreadyHere, failed }: ImportCount): ImportCount => ({
	copied,
	alreadyHere,
	failed,
});

/**
 * Create one folder file for each old row that has none yet. Safe to run
 * again after a partial run: it overwrites nothing.
 *
 * Old rows refer to each other by ID: a chat's focus names words, and a
 * message names its chat. A row is copied only when what it names is, in the
 * folder, the thing it named before. A chat whose focus ID is held by a
 * different word is not copied, so its stage control can never act on that
 * word. A message is not copied unless its chat's own copy is in the folder,
 * and a message with no chat row is not copied when a chat file already has
 * its conversation ID, so it can never join another chat's transcript.
 * Whatever is not copied is reported and stays in the earlier storage, and a
 * later run copies it once the conflict is gone.
 */
export async function importLegacy(
	tables: VocabTables,
	legacy: LegacyRows,
): Promise<ImportReport> {
	const words = await copyRows(
		legacy.entries,
		tables.entries,
		({ text, note, stage, createdAt }) => ({ text, note, stage, createdAt }),
		({ text, createdAt }) => [text, createdAt],
	);
	const chats = await copyRows(
		legacy.chats,
		tables.chats,
		({ createdAt, focus }) => ({ createdAt, focus }),
		({ createdAt, focus }) => [
			createdAt,
			focus?.map(({ entryId, text }) => [entryId, text]),
		],
		// A focus keeps the word's text, and a word's text never changes, so a
		// word file at the focus ID with any other text is a different word. No
		// file there is fine: the focus then shows its text with no control.
		async (row) => {
			for (const item of row.focus) {
				const word = await tables.entries.get(item.entryId);
				if (word.error !== null) return word.error.message;
				if (word.data && word.data.fields.text !== item.text)
					return `Its focus '${item.text}' names '${word.data.path}', which is a different word in this folder. The chat and its messages were left in the earlier storage.`;
			}
			return undefined;
		},
	);
	const chatRows = new Set(legacy.chats.map((row) => row.id));
	// One answer per message-only conversation: whether a chat file has its ID.
	const occupied = new Map<string, Promise<string | undefined>>();
	const messages = await copyRows(
		legacy.messages,
		tables.messages,
		// The folder checks the message's shape; one it refuses is reported.
		(row) => ({
			chat: row.conversationId,
			message: row.message as AgentMessage,
		}),
		({ chat, message }) => [chat, message?.id, message?.createdAt],
		async (row) => {
			const id = row.conversationId;
			if (chatRows.has(id))
				return chats.settled.has(id)
					? undefined
					: 'Its chat was not copied, so this message was left in the earlier storage.';
			// A conversation from before chats had a focus has no chat row. A
			// chat file with its ID is some other chat.
			let answer = occupied.get(id);
			if (!answer) {
				answer = tables.chats.get(id).then((chat) => {
					if (chat.error !== null) return chat.error.message;
					return chat.data
						? `Its conversation ID is the name of a different chat in this folder ('${chat.data.path}'), so this message was left in the earlier storage.`
						: undefined;
				});
				occupied.set(id, answer);
			}
			return answer;
		},
	);
	return {
		words: count(words),
		chats: count(chats),
		messages: count(messages),
	};
}
