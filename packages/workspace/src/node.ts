/**
 * Node and Bun-only workspace APIs.
 *
 * Keep these exports out of the root `@epicenter/workspace` barrel so browser
 * bundles do not traverse modules that import `node:*` or `bun:*`.
 */

export { connectDaemon } from './client/connect-daemon.js';
export { findEpicenterDir } from './client/find-epicenter-dir.js';
export type {
	DaemonActionOptions,
	DaemonActions,
} from './client/daemon-actions.js';
export { buildDaemonActions } from './client/daemon-actions.js';
export { buildApp, PeerSnapshot, RunRequest } from './daemon/app.js';
export {
	type DaemonClient,
	DaemonError,
	daemonClient,
	getDaemon,
	pingDaemon,
} from './daemon/client.js';
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
	logPathFor,
	metadataPathFor,
	runtimeDir,
	socketPathFor,
} from './daemon/paths.js';
export { RunError, type RunResponse } from './daemon/run-errors.js';
export {
	createWorkspaceServer,
	type WorkspaceServer,
	type WorkspaceServerOptions,
} from './daemon/server.js';
export type { LoadedWorkspace, WorkspaceEntry } from './daemon/types.js';
export {
	bindOrRecover,
	bindUnixSocket,
	StartupError,
	type UnixSocketServer,
	unlinkSocketFile,
} from './daemon/unix-socket.js';
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
export {
	markdownPath,
	sqlitePath,
	yjsPath,
} from './document/workspace-paths.js';
export { SqliteWriterError } from './document/sqlite-writer.js';
export { hashClientId } from './shared/client-id.js';
