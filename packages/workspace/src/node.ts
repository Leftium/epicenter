/**
 * Node and Bun-only workspace APIs.
 *
 * Keep these exports out of the root `@epicenter/workspace` barrel so browser
 * bundles do not traverse modules that import `node:*` or `bun:*`.
 */

export { connectDaemonActions } from './client/connect-daemon-actions.js';
export type {
	DaemonActionOptions,
	DaemonActions,
} from './client/daemon-actions.js';
export { buildDaemonActions } from './client/daemon-actions.js';
export { epicenterPaths } from './client/epicenter-paths.js';
export { findEpicenterDir } from './client/find-epicenter-dir.js';
export { buildDaemonApp, PeerSnapshot, RunRequest } from './daemon/app.js';
export {
	type DaemonClient,
	DaemonError,
	daemonClient,
	getDaemon,
	pingDaemon,
} from './daemon/client.js';
export {
	claimDaemonLease,
	type DaemonLease,
} from './daemon/lease.js';
export {
	type DaemonMetadata,
	enumerateDaemons,
	readMetadata,
	readMetadataFromPath,
	unlinkMetadata,
	writeMetadata,
} from './daemon/metadata.js';
export {
	dirHash,
	leasePathFor,
	logPathFor,
	metadataPathFor,
	runtimeDir,
	socketPathFor,
} from './daemon/paths.js';
export {
	findDuplicateDaemonRoute,
	isValidDaemonRoute,
	validateDaemonRouteNames,
} from './daemon/route-validation.js';
export {
	RunError,
	type RunResponse,
	type RunSyncStatus,
} from './daemon/run-errors.js';
export {
	type DaemonServer,
	type DaemonServerOptions,
	startDaemonServer,
} from './daemon/server.js';
export type {
	DaemonRouteContext,
	DaemonRouteDefinition,
	DaemonRuntime,
	EpicenterConfig,
	StartedDaemonRoute,
} from './daemon/types.js';
export { StartupError, unlinkSocketFile } from './daemon/unix-socket.js';
export {
	attachMarkdown,
	type MarkdownShape,
} from './document/attach-markdown.js';
export { attachSqlite } from './document/attach-sqlite.js';
export {
	type AttachSqliteReaderOptions,
	attachSqliteReader,
	type SqliteReaderAttachment,
} from './document/attach-sqlite-reader.js';
export {
	attachYjsLog,
	type YjsLogAttachment,
} from './document/attach-yjs-log.js';
export {
	attachYjsLogReader,
	type YjsLogReaderAttachment,
} from './document/attach-yjs-log-reader.js';
export { SqliteWriterError } from './document/sqlite-writer.js';
export {
	markdownPath,
	sqlitePath,
	yjsPath,
} from './document/workspace-paths.js';
export { hashClientId } from './shared/client-id.js';
