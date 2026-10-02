/**
 * What this device keeps for Whispering outside the folder's history: one JSON
 * object in `<root>/.git/epicenter/whispering/device.json`. Git never commits
 * anything under `.git`, so nothing here travels with the folder.
 *
 * The file holds the API key and the chosen microphone, and may hold fields a
 * later build added. Each change rewrites the whole file, so every change
 * starts from what the file holds at that moment and keeps every field it
 * does not name. Changes run one at a time: a key save and a microphone save
 * that overlap would otherwise each write back the other's old value.
 *
 * A file that is there and does not decode as one JSON object is never
 * replaced. It may still hold a key, or fields from another build, that a
 * person can recover by hand; a rewrite would destroy them. Reading it and
 * changing it both refuse until it is fixed or removed.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MicrophonePreference } from '../src/lib/capture.js';

export type DeviceValues = Readonly<Record<string, unknown>>;

/**
 * Said for any existing file that is not one JSON object. It names no path
 * and carries none of the file's text, which may hold the key.
 */
const UNDECODABLE =
	'This device’s Whispering settings file does not read as a JSON object, so it was left as it is. Fix or remove device.json under the folder’s .git/epicenter/whispering directory, then try again.';

const KEY_FIELD = 'transcriptionApiKey';
const MICROPHONE_FIELD = 'microphone';
/** Device IDs and names are short; anything longer is not one. */
const MAX_TEXT = 512;

/** The saved key, or '' when there is none. */
export function keyIn(values: DeviceValues): string {
	const key = values[KEY_FIELD];
	return typeof key === 'string' ? key : '';
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
	 * Replace the named fields and keep every other. `undefined` removes a
	 * field. The new file is written beside the old one and renamed over it,
	 * so an interrupted write leaves the old file whole.
	 */
	function update(change: Readonly<Record<string, unknown>>): Promise<void> {
		const run = changes.then(async () => {
			const next: Record<string, unknown> = { ...(await read()), ...change };
			for (const [field, value] of Object.entries(next))
				if (value === undefined) delete next[field];
			await mkdir(dirname(path), { recursive: true });
			const staged = `${path}.next`;
			await writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, {
				mode: 0o600,
			});
			await rename(staged, path);
		});
		changes = run.catch(() => {});
		return run;
	}

	return {
		read,
		setKey: (key: string) => update({ [KEY_FIELD]: key }),
		setMicrophone: (microphone: MicrophonePreference | undefined) =>
			update({ [MICROPHONE_FIELD]: microphone }),
	};
}
