/**
 * The audio a player holds, identified by the bytes it was made from.
 *
 * A player keeps a Blob, so it goes stale when the file is replaced. Size and
 * modification time cannot say whether that happened: a replacement can have
 * the same length. The folder's content hash can, so a reload compares
 * versions and hands back the same object when the bytes are the same, which
 * lets a player keep playing instead of restarting.
 */
import { type FileError, type FolderFiles } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';

export type LoadedAudio = {
	readonly path: string;
	readonly sha256: string;
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
	const { data: file, error: readError } = await files.read(path);
	if (readError !== null) return Err(readError);
	if (
		current !== undefined &&
		current.path === path &&
		current.sha256 === file.sha256
	)
		return Ok(current);
	return Ok({
		path,
		sha256: file.sha256,
		// The folder returns untyped bytes; a player needs the container's type.
		blob: new Blob([file.bytes as Uint8Array<ArrayBuffer>], {
			type: audioMimeTypeOf(path) ?? '',
		}),
	});
}
