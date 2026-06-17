/**
 * The node runtime for `WorkspaceDefinition.mount(...)`, plus the daemon-side
 * materializer helpers a mount's `compose` callback reaches for directly.
 *
 * `WorkspaceDefinition.mount(...)` lives in the browser-safe root barrel, so it
 * is a pure coordinator: it never imports a `node:*` or `bun:*` module. The
 * node-only capabilities the coordinator itself needs are injected through the
 * `runtime` argument, and `nodeMountRuntime()` is the one bag that supplies
 * them:
 *
 *  - `defineSessionMount` wraps the mount so a signed-out daemon reports
 *    `inactive` instead of running the body.
 *  - `attachInfrastructure` ({@link attachMountInfrastructure}) pins the
 *    deterministic `clientID`, persists the Yjs update log to disk, joins the
 *    cloud room, and owns the ordered async teardown.
 *  - `resolveBaseURL` collapses the `opts.baseURL || EPICENTER_API_URL ||
 *    hosted` fallback every mount used to repeat.
 *
 * The materializer helpers ({@link attachMountSqlite}, {@link
 * attachMountMarkdown}) are NOT on that bag. A mount's `compose` body is itself
 * node code (the app's `mount.ts` already imports `@epicenter/workspace/node`),
 * so it imports and calls them directly, passing the `scope` and the
 * `workspace`. They fill the deterministic disk path and the `${ctx.mount}-*`
 * logger from `scope.ctx`, and enroll their own teardown through
 * `scope.registerDrain` so a daemon shutdown drains them. A call site supplies
 * only what is genuinely its own (FTS columns, the table export config, git
 * autosave) and spreads the result's `.actions`. Keeping them off the injected
 * bag is what lets the coordinator stay a pure pass-through: it never touches a
 * materializer, only the `{ actions }` the body returns.
 *
 * Browser bundles import `WorkspaceDefinition.mount` as a type and never reach
 * this module: the daemon runtime they would call it with is constructed here,
 * in node-only code.
 *
 * @module
 */

import { join } from 'node:path';
import { createLogger } from 'wellcrafted/logger';
import * as Y from 'yjs';
import { attachYjsLog } from '../document/attach-yjs-log.js';
import {
	attachGitAutosave,
	attachMarkdownExport,
	type ExportTablesConfig,
	type GitAutosaveConfig,
	type MarkdownExport,
} from '../document/materializer/markdown/index.js';
import type {
	MaterializerInput,
	TablesRecord,
} from '../document/materializer/shared.js';
import type { FtsConfig } from '../document/materializer/sqlite/core.js';
import { attachBunSqliteMaterializer } from '../document/materializer/sqlite/index.js';
import { openCollaboration } from '../document/open-collaboration.js';
import { roomWsUrl } from '../document/transport.js';
import type { MountComposeScope } from '../document/workspace.js';
import { sqlitePath, yjsPath } from '../document/workspace-paths.js';
import { hashYDocClientId } from '../shared/client-id.js';
import {
	attachChildDocActor,
	type ChildDocActor,
	type ConnectedChildDoc,
	type ObservableChildDocLayout,
} from './attach-child-doc-actor.js';
import { attachMountInfrastructure } from './attach-mount-infrastructure.js';
import { defineSessionMount } from './define-mount.js';

const HOSTED_API_URL = 'https://api.epicenter.so';

/**
 * Options for {@link attachMountSqlite}. The helper fills the file path
 * (`sqlitePath(ctx.epicenterRoot, guid)`) and the `${ctx.mount}-sqlite` logger;
 * a call site supplies only what is its own.
 */
export type SqliteMountOptions<
	TTables extends TablesRecord,
	TFts extends FtsConfig<TTables> | undefined,
> = {
	/** Optional FTS5 config; keys must match `workspace.tables` names. */
	fts?: TFts;
};

/**
 * Options for {@link attachMountMarkdown}. The helper fills the base directory
 * (`ctx.epicenterRoot`) and the `${ctx.mount}-markdown` logger.
 */
export type MarkdownMountOptions<TTables extends TablesRecord> = {
	/** Per-table export config keyed by `workspace.tables` name; presence selects. */
	tables: ExportTablesConfig<TTables>;
	/**
	 * Git-autosave every exported table subdirectory with this config. Omit or
	 * `false` to disable. The watched dirs are exactly the markdown export's own
	 * subdirectories (`config.dir ?? tableName`), so the committed projection and
	 * its git history can never drift to different folders.
	 */
	git?: GitAutosaveConfig | false;
};

/**
 * Attach the daemon-side SQLite mirror for a mount's workspace. Call it from a
 * mount's `compose` body with the `scope` and the `workspace`; it enrolls its
 * own teardown through `scope.registerDrain`, so you only spread its `.actions`
 * into the served registry. There is no materializer list to remember: forgetting
 * to drain is not expressible.
 *
 * The file path and logger are derived from `scope.ctx`, so the call site passes
 * only its own FTS config.
 */
export function attachMountSqlite<
	TTables extends TablesRecord,
	TFts extends FtsConfig<TTables> | undefined = undefined,
>(
	scope: MountComposeScope,
	workspace: MaterializerInput<TTables>,
	options?: SqliteMountOptions<TTables, TFts>,
): ReturnType<typeof attachBunSqliteMaterializer<TTables, TFts>> {
	const { ctx, registerDrain } = scope;
	const materializer = attachBunSqliteMaterializer<TTables, TFts>(workspace, {
		filePath: sqlitePath(ctx.epicenterRoot, workspace.ydoc.guid),
		fts: options?.fts,
		log: createLogger(`${ctx.mount}-sqlite`),
	});
	registerDrain(materializer);
	return materializer;
}

/**
 * Attach the daemon-side markdown export for a mount's workspace, optionally
 * git-autosaving each exported subdirectory. Call it from a mount's `compose`
 * body with the `scope` and the `workspace`; it enrolls its own teardown through
 * `scope.registerDrain`, so you only spread its `.actions` into the served
 * registry.
 *
 * The base directory and logger are derived from `scope.ctx`, so the call site
 * passes only the per-table export config and git policy.
 */
export function attachMountMarkdown<TTables extends TablesRecord>(
	scope: MountComposeScope,
	workspace: MaterializerInput<TTables>,
	{ tables, git }: MarkdownMountOptions<TTables>,
): MarkdownExport {
	const { ctx, registerDrain } = scope;
	const markdown = attachMarkdownExport<TTables>(workspace, {
		dir: ctx.epicenterRoot,
		tables,
		log: createLogger(`${ctx.mount}-markdown`),
	});
	if (git) {
		// Autosave the export's own subdirs: one per selected table, the same
		// `config.dir ?? name` the export writes to.
		for (const [name, config] of Object.entries(tables) as [
			string,
			{ dir?: string } | undefined,
		][]) {
			attachGitAutosave({
				ydoc: workspace.ydoc,
				dir: join(ctx.epicenterRoot, config?.dir ?? name),
				config: git,
			});
		}
	}
	registerDrain(markdown);
	return markdown;
}

/**
 * Options for {@link attachMountChildDocActor}: the root doc to cascade teardown
 * off, the table to watch, the field's single-owner guid deriver, the declared
 * child-doc layout, and the optional `onChange` seam. Everything node-specific
 * (disk path, transport, logger) is filled from `scope`.
 */
export type ChildDocActorMountOptions<TRowId extends string, THandle> = {
	/** Root doc whose `destroy` flushes every hosted body (`workspace.ydoc`). */
	readonly rootDoc: Y.Doc;
	/** The table whose rows name the child docs to host (`workspace.tables.<t>`). */
	readonly table: {
		scan(): { readonly rows: ReadonlyArray<{ readonly id: TRowId }> };
		observe(callback: () => void): () => void;
	};
	/** The field's guid deriver (`workspace.tables.<t>.docs.<field>.guid`). */
	readonly guidFor: (rowId: TRowId) => string;
	/** The declared child-doc layout (e.g. `attachChatTranscript`). */
	readonly layout: ObservableChildDocLayout<THandle>;
	/** React to a hosted body's changes. The V0.3 claim -> stream -> finish seam. */
	readonly onChange?: (args: {
		rowId: TRowId;
		handle: THandle;
		ydoc: Y.Doc;
	}) => void;
};

/**
 * Attach the daemon-side child-doc observe loop for a mount's workspace: the
 * always-on actor that hosts a live replica of every row's child doc and watches
 * it (ADR-0012/0013). Call it from a mount's `compose` body with the `scope` and
 * the per-row pieces; it enrolls its own teardown through `scope.registerDrain`,
 * so a daemon shutdown awaits every hosted body's drain.
 *
 * The node-only per-body connector (deterministic `clientID`, disk update log,
 * cloud room join) is built here from `scope.ctx` and `scope.baseURL`, exactly
 * as {@link attachMountInfrastructure} connects the root doc. The pure observe
 * loop lives in {@link attachChildDocActor}, which stays transport-agnostic.
 */
export function attachMountChildDocActor<TRowId extends string, THandle>(
	scope: MountComposeScope,
	{
		rootDoc,
		table,
		guidFor,
		layout,
		onChange,
	}: ChildDocActorMountOptions<TRowId, THandle>,
): ChildDocActor {
	const { ctx, baseURL, registerDrain } = scope;

	const connectBody = (guid: string): ConnectedChildDoc => {
		const ydoc = new Y.Doc({ guid, gc: true });
		ydoc.clientID = hashYDocClientId(ctx.nodeId);
		const yjsLog = attachYjsLog(ydoc, {
			filePath: yjsPath(ctx.epicenterRoot, guid),
			log: createLogger(`${ctx.mount}-actor-log`),
		});
		const collaboration = openCollaboration(ydoc, {
			url: roomWsUrl({
				baseURL,
				ownerId: ctx.session.ownerId,
				guid,
				nodeId: ctx.nodeId,
			}),
			openWebSocket: ctx.session.openWebSocket,
			onReconnectSignal: ctx.session.onReconnectSignal,
			// A body's writers are the layout and the generation actor, never peer
			// dispatch, so it publishes no action manifest.
			actions: {},
			log: createLogger(`${ctx.mount}-actor-sync`),
		});
		return {
			ydoc,
			// `ydoc.destroy()` cascades both the log and the collaboration teardown,
			// the same order `attachMountInfrastructure` relies on for the root doc.
			whenDisposed: Promise.all([
				yjsLog.whenDisposed,
				collaboration.whenDisposed,
			]).then(() => {}),
			dispose() {
				ydoc.destroy();
			},
		};
	};

	const actor = attachChildDocActor<TRowId, THandle>({
		rootDoc,
		table,
		guidFor,
		connectBody,
		layout,
		onChange,
		log: createLogger(`${ctx.mount}-actor`),
	});
	registerDrain(actor);
	return actor;
}

/**
 * The injected node runtime `WorkspaceDefinition.mount(...)` coordinates. Build
 * one with {@link nodeMountRuntime} and pass it as `runtime`. It holds only the
 * capabilities the browser-safe coordinator itself calls; materializer helpers
 * ({@link attachMountSqlite}, {@link attachMountMarkdown}) are imported directly
 * by the mount body instead.
 */
export type NodeMountRuntime = {
	defineSessionMount: typeof defineSessionMount;
	attachInfrastructure: typeof attachMountInfrastructure;
	/**
	 * Resolve the sync base URL: an explicit value wins, then
	 * `EPICENTER_API_URL`, then the hosted API.
	 */
	resolveBaseURL(explicit?: string): string;
};

/**
 * Build the node runtime for `WorkspaceDefinition.mount(...)`.
 *
 * Lives in node-only code (this module imports the bun:sqlite and filesystem
 * materializers); call it from a mount factory and hand the result to `.mount`:
 *
 * ```ts
 * import { nodeMountRuntime } from '@epicenter/workspace/node';
 *
 * export function zhongwen(opts: ZhongwenMountOptions = {}) {
 *   return zhongwenWorkspace.mount({
 *     baseURL: opts.baseURL,
 *     runtime: nodeMountRuntime(),
 *   });
 * }
 * ```
 */
export function nodeMountRuntime(): NodeMountRuntime {
	return {
		defineSessionMount,
		attachInfrastructure: attachMountInfrastructure,
		resolveBaseURL: (explicit) =>
			explicit || process.env.EPICENTER_API_URL || HOSTED_API_URL,
	};
}
