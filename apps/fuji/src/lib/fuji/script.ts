import {
	attachEncryption,
	type ProjectDir,
	type ReadonlyTables,
} from '@epicenter/workspace';
import {
	attachYjsLogReader,
	type DaemonActionOptions,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import type { Result } from 'wellcrafted/result';
import * as Y from 'yjs';
import {
	type Entry,
	type EntryId,
	type createFujiActions,
	fujiTables,
} from '../workspace.js';
import {
	FUJI_DAEMON_ROUTE,
	FUJI_WORKSPACE_ID,
	openFujiDaemonActions,
} from './daemon.js';

type FujiActions = ReturnType<typeof createFujiActions>;
type FujiEntryActions = FujiActions['entries'];
type ActionInput<T> = T extends (input: infer TInput) => unknown
	? TInput
	: never;

export type FujiEntryCreateInput = ActionInput<FujiEntryActions['create']>;
export type FujiEntryUpdateInput = ActionInput<FujiEntryActions['update']>;
export type FujiEntryUpdatePatch = Omit<FujiEntryUpdateInput, 'id'>;
export type FujiEntryBulkCreateInput = ActionInput<
	FujiEntryActions['bulkCreate']
>;

export type OpenFujiSnapshotOptions = {
	projectDir?: ProjectDir;
	clientID?: number;
};

export type FujiScriptEntryTable = {
	get(id: EntryId, options?: DaemonActionOptions): Promise<Entry | null>;
	getAllValid(options?: DaemonActionOptions): Promise<Entry[]>;
	filter(
		predicate: (entry: Entry) => boolean,
		options?: DaemonActionOptions,
	): Promise<Entry[]>;
	find(
		predicate: (entry: Entry) => boolean,
		options?: DaemonActionOptions,
	): Promise<Entry | undefined>;
	count(options?: DaemonActionOptions): Promise<number>;
	has(id: EntryId, options?: DaemonActionOptions): Promise<boolean>;
	create(
		input: FujiEntryCreateInput,
		options?: DaemonActionOptions,
	): Promise<{ id: EntryId }>;
	set(
		row: Entry,
		options?: DaemonActionOptions,
	): Promise<{ id: EntryId }>;
	update(
		id: EntryId,
		partial: FujiEntryUpdatePatch,
		options?: DaemonActionOptions,
	): Promise<Entry | null>;
	delete(id: EntryId, options?: DaemonActionOptions): Promise<Entry | null>;
	restore(id: EntryId, options?: DaemonActionOptions): Promise<Entry | null>;
	bulkCreate(
		input: FujiEntryBulkCreateInput,
		options?: DaemonActionOptions,
	): Promise<{ count: number }>;
};

export function openFujiSnapshot({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
}: OpenFujiSnapshotOptions = {}) {
	const ydoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
	ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachReadonlyTables(ydoc, fujiTables);
	const yjsLog = attachYjsLogReader(ydoc, {
		filePath: yjsPath(projectDir, ydoc.guid),
	});

	return {
		tables,
		yjsLog,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

async function unwrapDaemonResult<TData, TError>(
	result: Promise<Result<TData, TError>>,
): Promise<TData> {
	const awaited = await result;
	if (awaited.error !== null) throw awaited.error;
	return awaited.data as TData;
}

function createFujiScriptEntryTable(
	actions: Awaited<ReturnType<typeof openFujiDaemonActions>>,
): FujiScriptEntryTable {
	const entries = actions.entries;

	return {
		get(id, options) {
			return unwrapDaemonResult(entries.get({ id }, options));
		},
		getAllValid(options) {
			return unwrapDaemonResult(entries.getAllValid({}, options));
		},
		async filter(predicate, options) {
			const rows = await this.getAllValid(options);
			return rows.filter(predicate);
		},
		async find(predicate, options) {
			const rows = await this.getAllValid(options);
			return rows.find(predicate);
		},
		count(options) {
			return unwrapDaemonResult(entries.count({}, options));
		},
		has(id, options) {
			return unwrapDaemonResult(entries.has({ id }, options));
		},
		create(input, options) {
			return unwrapDaemonResult(entries.create(input, options));
		},
		set(row, options) {
			return unwrapDaemonResult(entries.upsert(row, options));
		},
		update(id, partial, options) {
			return unwrapDaemonResult(entries.update({ id, ...partial }, options));
		},
		delete(id, options) {
			return unwrapDaemonResult(entries.delete({ id }, options));
		},
		restore(id, options) {
			return unwrapDaemonResult(entries.restore({ id }, options));
		},
		bulkCreate(input, options) {
			return unwrapDaemonResult(entries.bulkCreate(input, options));
		},
	};
}

export async function openFujiScript({
	route = FUJI_DAEMON_ROUTE,
	projectDir = findEpicenterDir(),
	clientID,
}: OpenFujiSnapshotOptions & { route?: string } = {}) {
	const snapshotAttachment = openFujiSnapshot({ projectDir, clientID });
	const actions = await openFujiDaemonActions({ route, projectDir });

	return {
		tables: {
			entries: createFujiScriptEntryTable(actions),
		},
		snapshot: snapshotAttachment.tables satisfies ReadonlyTables<
			typeof fujiTables
		>,
		actions,
		async [Symbol.asyncDispose]() {
			snapshotAttachment[Symbol.dispose]();
			await snapshotAttachment.yjsLog.whenDisposed;
		},
	};
}
