/**
 * The audio a player holds, identified by the bytes it was made from.
 *
 * A player keeps a Blob, so it goes stale when the file is replaced. Size and
 * modification time cannot say whether that happened: a replacement can have
 * the same length. The folder's content version can, so a reload compares
 * versions and hands back the same object when the bytes are the same, which
 * lets a player keep playing instead of restarting.
 */
import {
	type FileError,
	type FileVersion,
	type FolderFiles,
	sameVersion,
} from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';

export type LoadedAudio = {
	readonly path: string;
	readonly version: FileVersion;
	readonly blob: Blob;
};

/**
 * Read the audio at `path` as it is now. Returns `current` itself when it
 * already holds exactly these bytes for this path.
 */
export async function loadAudio(
	files: Pick<FolderFiles, 'read'>,
	path: string,
	current: LoadedAudio | undefined,
): Promise<Result<LoadedAudio, FileError>> {
	const read = await files.read(path);
	if (read.error) return read;
	if (
		current !== undefined &&
		current.path === path &&
		sameVersion(current.version, read.data.version)
	)
		return Ok(current);
	return Ok({
		path,
		version: read.data.version,
		// The folder returns untyped bytes; a player needs the container's type.
		blob: new Blob([read.data.bytes as Uint8Array<ArrayBuffer>], {
			type: audioMimeTypeOf(path) ?? '',
		}),
	});
}
