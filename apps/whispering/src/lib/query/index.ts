import { actions } from './actions';
import { audio } from './audio';
import { download } from './download';
import { text } from './text';
import { transcription } from './transcription';
import { transformer } from './transformer';

/**
 * Cross-platform RPC namespace.
 * These query operations are available on both web and desktop.
 */
export const rpc = {
	text,
	actions,
	audio,
	download,
	transcription,
	transformer,
};
