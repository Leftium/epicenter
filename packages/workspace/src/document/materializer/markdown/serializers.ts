/**
 * Compatibility export for the markdown materializer package path.
 *
 * Filename serialization is shared document markdown behavior. Keeping the
 * implementation in one folder prevents slug rules from drifting between the
 * direct markdown API and materializer API.
 */
export {
	slugFilename,
	toIdFilename,
	toSlugFilename,
} from '../../markdown/serializers.js';
