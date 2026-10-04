/**
 * What this device keeps for Whispering outside the folder's history: one JSON
 * object in `<root>/.git/epicenter/whispering/device.json`. Git never commits
 * anything under `.git`, so Git transfers exclude this file. A full directory
 * copy still carries its API key and device preferences.
 *
 * The file holds the two connections (each a base URL, a default model, and
 * an optional key), the chosen microphone, and may hold fields a later build
 * added. An earlier build kept one key for every endpoint in
 * `transcriptionApiKey`; that field is left exactly as it is, sent nowhere,
 * until the person moves it into a connection.
 *
 * Each change rewrites the whole file, so every change starts from what the
 * file holds at that moment and keeps every field it does not name. Changes
 * run one at a time: a connection save and a microphone save that overlap
 * would otherwise each write back the other's old value. A connection's base
 * URL and key change in one write, so no reader ever sees a key beside a URL
 * it was not saved for.
 *
 * A file that is there and does not decode as one JSON object is never
 * replaced. It may still hold a key, or fields from another build, that a
 * person can recover by hand; a rewrite would destroy them. Reading it and
 * changing it both refuse until it is fixed or removed.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MicrophonePreference } from '../src/lib/capture.js';
import {
	adoptLegacyKey,
	applyConnectionChange,
	type ConnectionChange,
	type LegacyKeyTargets,
	OPERATION_NAMES,
	OPERATIONS,
	type Operation,
	readStoredConnection,
	type StoredConnection,
} from '../src/lib/connections.js';

export type DeviceValues = Readonly<Record<string, unknown>>;

/**
 * Said for any existing file that is not one JSON object. It names no path
 * and carries none of the file's text, which may hold the key.
 */
const UNDECODABLE =
	'This device’s Whispering settings file does not read as a JSON object, so it was left as it is. Fix or remove device.json under the folder’s .git/epicenter/whispering directory, then try again.';

/** Where an earlier build kept its one key. Read only to move it into a connection. */
const LEGACY_KEY_FIELD = 'transcriptionApiKey';
const CONNECTION_FIELDS: Record<Operation, string> = {
	transcription: 'transcriptionConnection',
	text: 'textConnection',
};
const MICROPHONE_FIELD = 'microphone';
/** Device IDs and names are short; anything longer is not one. */
const MAX_TEXT = 512;

/** The key an earlier build saved, or '' when there is none. */
export function legacyKeyIn(values: DeviceValues): string {
	const key = values[LEGACY_KEY_FIELD];
	return typeof key === 'string' ? key : '';
}

/**
 * The connection saved for an operation, or undefined when none is. One that
 * is saved and does not read as a connection throws, so it is reported
 * rather than taken for none. The message quotes nothing from the file.
 */
export function connectionIn(
	values: DeviceValues,
	operation: Operation,
): StoredConnection | undefined {
	const value = values[CONNECTION_FIELDS[operation]];
	if (value === undefined) return undefined;
	const stored = readStoredConnection(value);
	if (stored === undefined)
		throw new Error(
			`This device’s ${OPERATION_NAMES[operation]} connection does not read as one. Fix or remove its entry in device.json under the folder’s .git/epicenter/whispering directory, then try again.`,
		);
	return stored;
}

/** The saved microphone, or undefined when none is saved or it does not read as one. */
export function microphoneIn(
	values: DeviceValues,
): MicrophonePreference | undefined {
	return readMicrophone(values[MICROPHONE_FIELD]);
}

/** A microphone preference from untrusted input, or undefined when it is not one. */
export function readMicrophone(
	value: unknown,
): MicrophonePreference | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { deviceId, label } = value as Record<string, unknown>;
	if (
		typeof deviceId !== 'string' ||
		deviceId === '' ||
		deviceId.length > MAX_TEXT
	)
		return undefined;
	if (typeof label !== 'string' || label.length > MAX_TEXT) return undefined;
	return { deviceId, label };
}

export function createDeviceFile(path: string) {
	/**
	 * The file's object. Only an absent file holds nothing. A file that is
	 * there and cannot be read, or whose text is not one JSON object, throws,
	 * so a change never replaces fields it could not see.
	 */
	async function read(): Promise<DeviceValues> {
		let text: string;
		try {
			text = await readFile(path, 'utf8');
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
			throw cause;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// The parser's own message can quote the text. It is not passed on.
			throw new Error(UNDECODABLE);
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new Error(UNDECODABLE);
		return parsed as DeviceValues;
	}

	let changes: Promise<unknown> = Promise.resolve();

	/**
	 * Replace the fields `compute` names, from the file as it is when this
	 * change's turn comes, and keep every other. `undefined` removes a field.
	 * `compute` may throw to refuse, and then nothing is written. The new file
	 * is written beside the old one and renamed over it, so an interrupted
	 * write leaves the old file whole.
	 */
	function update<T>(
		compute: (values: DeviceValues) => {
			readonly change: Readonly<Record<string, unknown>>;
			readonly result: T;
		},
	): Promise<T> {
		const run = changes.then(async () => {
			const current = await read();
			const { change, result } = compute(current);
			const next: Record<string, unknown> = { ...current, ...change };
			for (const [field, value] of Object.entries(next))
				if (value === undefined) delete next[field];
			await mkdir(dirname(path), { recursive: true });
			const staged = `${path}.next`;
			await writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, {
				mode: 0o600,
			});
			await rename(staged, path);
			return result;
		});
		changes = run.catch(() => {});
		return run;
	}

	return {
		read,
		/**
		 * Save one connection from the one saved now. The base URL, model, and
		 * key change together; a kept key stays only for the same base URL.
		 */
		setConnection: (operation: Operation, change: ConnectionChange) =>
			update((values) => {
				const next = applyConnectionChange(
					operation,
					connectionIn(values, operation),
					change,
				);
				if (next.error !== null) throw new Error(next.error);
				return {
					change: { [CONNECTION_FIELDS[operation]]: next.data },
					result: next.data,
				};
			}),
		/**
		 * Move the earlier build's key into the connections the person chose,
		 * each at the base URL they were shown, and remove it from where it was.
		 * One write: the key is never in two places that disagree.
		 */
		adoptLegacyKey: (
			targets: LegacyKeyTargets,
			readOnly: Partial<Record<Operation, string>>,
		) =>
			update((values) => {
				const adopted = adoptLegacyKey(legacyKeyIn(values), targets, readOnly);
				if (adopted.error !== null) throw new Error(adopted.error);
				const change: Record<string, unknown> = {
					[LEGACY_KEY_FIELD]: undefined,
				};
				for (const operation of OPERATIONS) {
					const connection = adopted.data[operation];
					if (connection !== undefined) {
						connectionIn(values, operation);
						change[CONNECTION_FIELDS[operation]] = connection;
					}
				}
				return { change, result: undefined };
			}),
		setMicrophone: (microphone: MicrophonePreference | undefined) =>
			update(() => ({
				change: { [MICROPHONE_FIELD]: microphone },
				result: undefined,
			})),
	};
}
