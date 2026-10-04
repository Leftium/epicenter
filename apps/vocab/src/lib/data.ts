import type { AgentMessage } from '@epicenter/agent';
import { jsonValue } from '@epicenter/app/field';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	type TableListing,
	type TableSnapshot,
} from '@epicenter/folder';
import { Type } from 'typebox';
/**
 * Vocab's folder declaration and how its row files read. Isomorphic and inert:
 * importing it opens nothing.
 *
 * One local folder holds everything Vocab saves: the learner's words, each
 * chat's fixed focus, and every finished message. A saved thing is one
 * Markdown file, and a save is confirmed by the folder's receipt for that
 * file. Nothing here has an account in it.
 */

import type { ServableModel } from '@epicenter/constants/ai-providers';

/**
 * The initial model for this device's tutor workflow. The learner may choose
 * another model through the inference picker; messages do not store that choice.
 */
export const VOCAB_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

/**
 * The English vocabulary tutor's system prompt. Messages remain plain text
 * during streaming and render as Markdown when a response finishes.
 */
export const VOCAB_SYSTEM_PROMPT = `You are an English vocabulary tutor. Help the learner understand English words and phrases and use them naturally.

Guidelines:
- Explain meanings in clear English, with natural English examples.
- Show how meaning or tone changes with context when it matters.
- Answer follow-up questions and explain pronunciation when asked.
- Adjust difficulty from the learner's question rather than assuming a proficiency level.
- Do not claim to measure the learner's mastery or change saved entry stages.`;

/** Focus is model context, not a transcript message. */
export function tutorPrompt(
	focus: readonly { text: string }[],
	opening: boolean,
): string {
	return `${VOCAB_SYSTEM_PROMPT}\n\nThis chat focuses on these expressions: ${focus.map((item) => item.text).join(', ')}. ${opening ? 'Open the conversation yourself. Use them naturally and invite the learner to respond.' : 'Keep the focus in mind as you answer the learner.'} Do not ask for a definition quiz.`;
}

export const STAGES = ['new', 'recognized', 'understood', 'usable'] as const;
export type Stage = (typeof STAGES)[number];
/** What the learner reads for each stage. Only the learner sets one. */
export const STAGE_LABELS: Record<Stage, string> = {
	new: 'New',
	recognized: 'Recognize',
	understood: 'Understand',
	usable: 'Use',
};

/**
 * Learner-selected English expressions and their self-reported ability stage.
 * Notes and stages have one owner: the learner.
 */
const entriesTable = defineTable({
	fields: {
		text: field.string(),
		note: field.string(),
		stage: field.select(STAGES),
		createdAt: field.instant(),
	},
});

/** A chat is its creation time and the focus the learner chose for it. */
const chatsTable = defineTable({
	fields: {
		createdAt: field.instant(),
		focus: field.json(
			Type.Array(Type.Object({ entryId: Type.String(), text: Type.String() }), {
				minItems: 1,
				maxItems: 3,
			}),
		),
	},
});

/** One finished message, whole, and the stem of the chat it belongs to. */
const messagesTable = defineTable({
	fields: {
		chat: field.string(),
		message: field.json(
			Type.Object({
				id: Type.String(),
				role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
				createdAt: Type.Number(),
				parts: Type.Array(
					Type.Union([
						Type.Object({ type: Type.Literal('text'), text: Type.String() }),
						Type.Object({
							type: Type.Literal('tool-call'),
							toolCallId: Type.String(),
							toolName: Type.String(),
							input: jsonValue,
						}),
						Type.Object({
							type: Type.Literal('tool-result'),
							toolCallId: Type.String(),
							toolName: Type.String(),
							content: Type.String(),
							details: Type.Optional(jsonValue),
							isError: Type.Boolean(),
						}),
					]),
				),
			}),
		),
	},
});

export const vocabFolder = defineFolder({
	title: 'Vocab',
	kv: {},
	tables: {
		entries: entriesTable,
		chats: chatsTable,
		messages: messagesTable,
	},
});

export type VocabFolder = Folder<typeof vocabFolder>;
export type VocabTables = VocabFolder['tables'];

type SnapshotOf<TName extends keyof VocabTables> = NonNullable<
	Awaited<ReturnType<VocabTables[TName]['get']>>['data']
>;

/**
 * One saved word. `id` is the file stem; `file` is the capture deletion is made
 * against, so deleting a word that changed since it was read is refused.
 * Structured edits use the canonical row editor and save the whole word.
 */
export type Entry = {
	id: string;
	text: string;
	note: string;
	stage: Stage;
	createdAt: string;
	file: SnapshotOf<'entries'>;
};

export type FocusItem = { entryId: string; text: string };
export type Chat = { id: string; createdAt: string; focus: FocusItem[] };
export type ChatMessage = { stem: string; chat: string; message: AgentMessage };

/**
 * The saved word a focus item's stage control acts on, if there is one. A
 * focus keeps the word's ID and its text, and a word's text never changes,
 * so a word at that ID with another text is a different word and is not it.
 */
export function focusWord(
	entries: readonly Entry[],
	item: FocusItem,
): Entry | undefined {
	return entries.find(
		(entry) => entry.id === item.entryId && entry.text === item.text,
	);
}

/** A row file Vocab cannot show as a row, and why. It is never dropped silently. */
export type UnreadableFile = { path: string; reason: string };

export function readEntry(file: SnapshotOf<'entries'>): Entry | undefined {
	const { text, note, stage, createdAt } = file.fields;
	if (
		text === undefined ||
		note === undefined ||
		stage === undefined ||
		createdAt === undefined
	)
		return undefined;
	return { id: file.stem, text, note, stage, createdAt, file };
}

export function readChat(file: SnapshotOf<'chats'>): Chat | undefined {
	const { createdAt, focus } = file.fields;
	if (createdAt === undefined || focus === undefined) return undefined;
	return {
		id: file.stem,
		createdAt,
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
}

export function readMessage(
	file: SnapshotOf<'messages'>,
): ChatMessage | undefined {
	const { chat, message } = file.fields;
	if (chat === undefined || message === undefined) return undefined;
	// The reading is frozen and already checked against the message schema;
	// the tutor loop owns a plain copy of it.
	return {
		stem: file.stem,
		chat,
		message: structuredClone(message) as AgentMessage,
	};
}

/**
 * Split a table listing into the rows Vocab can show and the files it cannot.
 * A file that could not be read, whose text does not parse, or that lacks a
 * field the row needs is reported with its path, never left out.
 */
export function readRows<TFields, TRow>(
	listing: TableListing<TFields>,
	read: (file: TableSnapshot<TFields>) => TRow | undefined,
): { rows: TRow[]; unreadable: UnreadableFile[] } {
	const rows: TRow[] = [];
	const unreadable: UnreadableFile[] = [];
	for (const { path, result } of listing) {
		const { data: file, error: readError } = result;
		if (readError !== null) {
			// A file removed between enumeration and its read is simply gone.
			if (readError.name !== 'NotFound')
				unreadable.push({ path, reason: readError.message });
			continue;
		}
		const row = read(file);
		if (row !== undefined) {
			rows.push(row);
			continue;
		}
		unreadable.push({
			path,
			reason:
				file.parseError?.message ??
				(file.issues.map((issue) => issue.message).join('; ') ||
					'A required field is missing.'),
		});
	}
	return { rows, unreadable };
}
