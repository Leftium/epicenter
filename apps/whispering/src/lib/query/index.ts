import { actions } from './actions';
import { analytics } from './analytics';
import { audio } from './audio';
import { delivery } from './delivery';
import { download } from './download';
import { notify } from './notify';
import { localShortcuts } from './shortcuts';
import { sound } from './sound';
import { text } from './text';
import { transcription } from './transcription';
import { transformer } from './transformer';

/**
 * Cross-platform RPC namespace.
 * These query operations are available on both web and desktop.
 */
export const rpc = {
	analytics,
	text,
	actions,
	audio,
	download,
	localShortcuts,
	sound,
	transcription,
	transformer,
	notify,
	delivery,
};
