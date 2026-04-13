/**
 * Shared contract that all materializer extensions satisfy.
 *
 * Both the markdown materializer (`createMarkdownMaterializer`) and the SQLite
 * materializer (`createSqliteMaterializer`) return builders whose final shape
 * includes at least these two members. This type documents the pattern without
 * forcing inheritance—each materializer adds its own domain-specific methods
 * (e.g. `.search()` on the SQLite side, `.kv()` on the markdown side).
 *
 * Consumers that need to accept "any materializer" can type against this.
 */
export type MaterializerExtension = {
	/** Resolves once the materializer has finished its initial load. */
	whenReady: Promise<void>;

	/** Tear down observers and release resources. */
	dispose(): void;
};
