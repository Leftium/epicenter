/**
 * An object containing information needed for the client to connect to a document.
 *
 * The `url` field is the **fully-formed** WebSocket URL with the docId already
 * in the path. The provider does not append anything to it.
 */
export type ClientToken = {
	/** Fully-formed WebSocket URL (docId already in path). */
	url: string;

	/** Optional auth token (appended as ?token=xxx). */
	token?: string;
};
