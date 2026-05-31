/**
 * Fuji Tauri markdown push/pull (WIP, not yet wired to UI).
 *
 * Manual export/import of entries as `<id>.md` files with YAML frontmatter for
 * the Tauri desktop app. Uses `js-yaml` (not bun's YAML) because this runs in
 * the Tauri webview. Distinct from the daemon's live markdown materializer.
 *
 * The frontmatter serialization here is a hand-rolled parallel of the canonical
 * `@epicenter/workspace/markdown` serializer; when this is wired up, unify them
 * via a browser-safe YAML codec instead of maintaining both.
 */

import type { DateTimeString, IanaTimeZone } from '@epicenter/workspace';
import { dump, load } from 'js-yaml';
import type { Entry, EntryId, FujiWorkspace } from './index';
import { asEntryId } from './index';
import { tauri } from '#platform/tauri';

type FujiMarkdownHost = Pick<FujiWorkspace, 'tables'> & {
	idb: {
		whenLoaded: Promise<unknown>;
	};
	entryBodies: {
		open(entryId: EntryId): {
			whenLoaded: Promise<unknown>;
			read(): string;
			write(text: string): void;
			[Symbol.dispose](): void;
		};
	};
};

type EntryMetadata = Omit<Entry, 'id'> & {
	id: string;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function createFujiMarkdownActions(host: FujiMarkdownHost) {
	const platform = tauri;
	if (!platform) return {};

	return {
		async pushToMarkdown() {
			await host.idb.whenLoaded;
			const entries = host.tables.entries.getAllValid();
			const files = await Promise.all(
				entries.map(async (entry) => {
					using contentDoc = host.entryBodies.open(entry.id);
					await contentDoc.whenLoaded;
					return {
						filename: entryFilename(entry.id),
						content: serializeEntryMarkdown({
							entry,
							body: contentDoc.read(),
						}),
					};
				}),
			);
			await platform.markdown.writeFiles(files);
			return { count: files.length };
		},

		async pullFromMarkdown() {
			await host.idb.whenLoaded;
			const files = await platform.markdown.readFiles();
			const imported = files.map(parseEntryMarkdown);

			for (const { entry, body } of imported) {
				using contentDoc = host.entryBodies.open(entry.id);
				await contentDoc.whenLoaded;
				contentDoc.write(body);
			}

			await host.tables.entries.bulkSet(imported.map(({ entry }) => entry));
			return { count: imported.length };
		},
	};
}

function entryFilename(id: EntryId): string {
	return `${encodeURIComponent(id)}.md`;
}

function serializeEntryMarkdown({
	entry,
	body,
}: {
	entry: Entry;
	body: string;
}): string {
	const metadata: EntryMetadata = {
		id: entry.id,
		title: entry.title,
		subtitle: entry.subtitle,
		type: entry.type,
		tags: entry.tags,
		pinned: entry.pinned,
		deletedAt: entry.deletedAt,
		date: entry.date,
		dateZone: entry.dateZone,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		rating: entry.rating,
	};
	return `---\n${dump(metadata, {
		lineWidth: -1,
		noRefs: true,
		sortKeys: false,
	})}---\n${body}`;
}

function parseEntryMarkdown({
	filename,
	content,
}: {
	filename: string;
	content: string;
}): { entry: Entry; body: string } {
	const match = content.match(FRONTMATTER_PATTERN);
	if (!match) {
		throw new Error(`Markdown file is missing frontmatter: ${filename}`);
	}

	const frontmatter = match[1];
	if (frontmatter === undefined) {
		throw new Error(`Markdown file is missing frontmatter: ${filename}`);
	}

	const metadata = parseMetadata(load(frontmatter), filename);
	return {
		entry: {
			...metadata,
			id: asEntryId(metadata.id),
		},
		body: content.slice(match[0].length),
	};
}

function parseMetadata(value: unknown, filename: string): EntryMetadata {
	if (!isRecord(value)) {
		throw new Error(`Markdown frontmatter must be an object: ${filename}`);
	}

	const metadata = {
		id: readString(value, 'id', filename),
		title: readString(value, 'title', filename),
		subtitle: readString(value, 'subtitle', filename),
		type: readStringArray(value, 'type', filename),
		tags: readStringArray(value, 'tags', filename),
		pinned: readBoolean(value, 'pinned', filename),
		deletedAt: readNullableString(value, 'deletedAt', filename),
		date: readString(value, 'date', filename) as DateTimeString,
		dateZone: readString(value, 'dateZone', filename) as IanaTimeZone,
		createdAt: readString(value, 'createdAt', filename) as DateTimeString,
		updatedAt: readString(value, 'updatedAt', filename) as DateTimeString,
		rating: readNumber(value, 'rating', filename),
	};

	return metadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): string {
	const field = value[key];
	if (typeof field !== 'string') {
		throw new Error(`Frontmatter field "${key}" must be a string: ${filename}`);
	}
	return field;
}

function readNullableString(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): DateTimeString | null {
	const field = value[key];
	if (field === null) return null;
	if (typeof field !== 'string') {
		throw new Error(
			`Frontmatter field "${key}" must be a string or null: ${filename}`,
		);
	}
	return field as DateTimeString;
}

function readStringArray(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): string[] {
	const field = value[key];
	if (!Array.isArray(field) || field.some((item) => typeof item !== 'string')) {
		throw new Error(
			`Frontmatter field "${key}" must be a string array: ${filename}`,
		);
	}
	return field;
}

function readBoolean(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): boolean {
	const field = value[key];
	if (typeof field !== 'boolean') {
		throw new Error(
			`Frontmatter field "${key}" must be a boolean: ${filename}`,
		);
	}
	return field;
}

function readNumber(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): number {
	const field = value[key];
	if (typeof field !== 'number') {
		throw new Error(`Frontmatter field "${key}" must be a number: ${filename}`);
	}
	return field;
}
