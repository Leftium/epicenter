/**
 * A folder batch as data, so it can cross the bridge.
 *
 * `folder.batch` takes a callback, and a callback cannot be sent to another
 * process. The page runs the callback against a recorder that only writes
 * down which mutations were named, in order (`folder-client.ts`). The host
 * checks that list here and names the same mutations on the real folder's
 * batch, which validates, serializes, and publishes them. Nothing about a
 * row's source, a path's validity, or a condition is decided on the way.
 *
 * This module is plain TypeScript with no platform imports. The page and the
 * Bun folder host both load it. Nothing here is specific to Whispering.
 */
import type { DataDefinition } from '@epicenter/definition';
import type { BatchTable, FileCapture, FolderBatch } from '@epicenter/folder';

export type BatchContent = string | Uint8Array;

/** A typed row as `batch.tables.<name>.create` takes it. */
export type BatchRowInput = {
	readonly stem: string;
	readonly fields: unknown;
	readonly body?: string;
};

/** One named mutation, with the arguments the folder's batch verb takes. */
export type BatchStep =
	| {
			readonly op: 'files.create' | 'files.overwrite';
			readonly path: string;
			readonly content: BatchContent;
	  }
	| {
			readonly op: 'files.replace';
			readonly file: FileCapture;
			readonly content: BatchContent;
	  }
	| { readonly op: 'files.remove'; readonly file: FileCapture }
	| {
			readonly op: 'files.move';
			readonly file: FileCapture;
			readonly destination: string;
	  }
	| {
			readonly op: 'tables.create';
			readonly table: string;
			readonly input: BatchRowInput;
	  };

export type BatchPlan = readonly BatchStep[];

export class InvalidBatchPlan extends Error {
	constructor(reason: string) {
		super(`The batch plan is not usable: ${reason}`);
		this.name = 'InvalidBatchPlan';
	}
}

const isContent = (value: unknown): value is BatchContent =>
	typeof value === 'string' || value instanceof Uint8Array;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check what arrived over the bridge before any of it reaches the folder: a
 * list of known mutations whose arguments have the right shapes, naming only
 * tables the folder declares. Paths, stems, captures, and field values are
 * the folder's to judge, and it refuses them as it does for any caller.
 */
export function parseBatchPlan(
	value: unknown,
	tableNames: readonly string[],
): BatchPlan {
	if (!Array.isArray(value)) throw new InvalidBatchPlan('it is not a list');
	return value.map((step: unknown, index): BatchStep => {
		const refuse = (reason: string): never => {
			throw new InvalidBatchPlan(`step ${index + 1} ${reason}`);
		};
		if (!isRecord(step)) return refuse('is not a mutation');
		const { op, path, content, file, destination, table, input } = step;
		switch (op) {
			case 'files.create':
			case 'files.overwrite':
				if (typeof path !== 'string') return refuse('has no path');
				if (!isContent(content)) return refuse('has no content');
				return { op, path, content };
			case 'files.replace':
				if (!isContent(content)) return refuse('has no content');
				return { op, file: file as FileCapture, content };
			case 'files.remove':
				return { op, file: file as FileCapture };
			case 'files.move':
				if (typeof destination !== 'string')
					return refuse('has no destination');
				return { op, file: file as FileCapture, destination };
			case 'tables.create':
				if (typeof table !== 'string' || !tableNames.includes(table))
					return refuse('names a table this folder does not declare');
				if (!isRecord(input)) return refuse('has no row');
				if (input.body !== undefined && typeof input.body !== 'string')
					return refuse('has a body that is not text');
				return {
					op,
					table,
					input: {
						// A stem that is not text is refused by the folder, as `InvalidStem`.
						stem: input.stem as string,
						fields: input.fields,
						body: input.body,
					},
				};
			default:
				return refuse('is not a batch mutation');
		}
	});
}

/** Name a checked plan's mutations on a folder's batch collector, in order. */
export function collectBatchPlan(
	batch: FolderBatch<DataDefinition>,
	plan: BatchPlan,
): undefined {
	for (const step of plan) {
		switch (step.op) {
			case 'files.create':
				batch.files.create(step.path, step.content);
				break;
			case 'files.overwrite':
				batch.files.overwrite(step.path, step.content);
				break;
			case 'files.replace':
				batch.files.replace(step.file, step.content);
				break;
			case 'files.remove':
				batch.files.remove(step.file);
				break;
			case 'files.move':
				batch.files.move(step.file, step.destination);
				break;
			case 'tables.create': {
				// `parseBatchPlan` admitted only declared tables. A step that names
				// any other is refused here: it is never dropped from the batch.
				if (!Object.hasOwn(batch.tables, step.table))
					throw new InvalidBatchPlan(
						`'${step.table}' is not a table of this folder`,
					);
				// The folder checks the row's values against the declared fields.
				(batch.tables[step.table] as BatchTable<unknown>).create(step.input);
				break;
			}
		}
	}
	return undefined;
}
