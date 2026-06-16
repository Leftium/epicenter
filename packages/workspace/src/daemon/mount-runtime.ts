/**
 * The node runtime for `WorkspaceDefinition.mount(...)`.
 *
 * `WorkspaceDefinition.mount(...)` lives in the browser-safe root barrel, so it
 * is a pure coordinator: it never imports a `node:*` or `bun:*` module. Every
 * node-only capability a daemon mount needs is injected through the `runtime`
 * argument, and `nodeMountRuntime()` is the one bag that supplies them:
 *
 *  - `defineSessionMount` wraps the mount so a signed-out daemon reports
 *    `inactive` instead of running the body.
 *  - `attachInfrastructure` ({@link attachMountInfrastructure}) pins the
 *    deterministic `clientID`, persists the Yjs update log to disk, joins the
 *    cloud room, and owns the ordered async teardown.
 *  - `resolveBaseURL` collapses the `opts.baseURL || EPICENTER_API_URL ||
 *    hosted` fallback every mount used to repeat.
 *  - `bind(ctx)` returns the ctx-bound materializer helpers a mount's `compose`
 *    callback uses (`runtime.sqlite(...)`, `runtime.markdown(...)`). They close
 *    over `ctx.epicenterRoot` and `ctx.mount` so a call site passes only the
 *    workspace and the parts that are genuinely its own (FTS columns, the table
 *    export config, git autosave).
 *
 * Browser bundles import `WorkspaceDefinition.mount` as a type and never reach
 * this module: the daemon runtime they would call it with is constructed here,
 * in node-only code.
 *
 * @module
 */

import { join } from 'node:path';
import { createLogger } from 'wellcrafted/logger';
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
import { sqlitePath } from '../document/workspace-paths.js';
import { attachMountInfrastructure } from './attach-mount-infrastructure.js';
import {
	defineSessionMount,
	type SessionMountContext,
} from './define-mount.js';

const HOSTED_API_URL = 'https://api.epicenter.so';

/**
 * Options for the ctx-bound sqlite helper. The runtime fills the file path
 * (`sqlitePath(epicenterRoot, guid)`) and the `${mount}-sqlite` logger; a call
 * site supplies only what is its own.
 */
export type SqliteMountOptions<
	TTables extends TablesRecord,
	TFts extends FtsConfig<TTables> | undefined,
> = {
	/** Optional FTS5 config; keys must match `workspace.tables` names. */
	fts?: TFts;
};

/**
 * Options for the ctx-bound markdown helper. The runtime fills the base
 * directory (`epicenterRoot`) and the `${mount}-markdown` logger.
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
 * The ctx-bound materializer helpers a mount's `compose` callback receives as
 * `runtime`. Each builds a daemon-side materializer over the workspace's tables;
 * the call site spreads the result's `.actions` into the served registry and
 * lists it under `materializers` for ordered teardown.
 */
export type BoundMountRuntime = {
	sqlite<
		TTables extends TablesRecord,
		TFts extends FtsConfig<TTables> | undefined = undefined,
	>(
		workspace: MaterializerInput<TTables>,
		options?: SqliteMountOptions<TTables, TFts>,
	): ReturnType<typeof attachBunSqliteMaterializer<TTables, TFts>>;
	markdown<TTables extends TablesRecord>(
		workspace: MaterializerInput<TTables>,
		options: MarkdownMountOptions<TTables>,
	): MarkdownExport;
};

/**
 * The injected node runtime `WorkspaceDefinition.mount(...)` coordinates. Build
 * one with {@link nodeMountRuntime} and pass it as `runtime`.
 */
export type NodeMountRuntime = {
	defineSessionMount: typeof defineSessionMount;
	attachInfrastructure: typeof attachMountInfrastructure;
	/**
	 * Resolve the sync base URL: an explicit value wins, then
	 * `EPICENTER_API_URL`, then the hosted API.
	 */
	resolveBaseURL(explicit?: string): string;
	/** Bind the materializer helpers to one open's `ctx`. */
	bind(ctx: SessionMountContext): BoundMountRuntime;
};

/**
 * Build the node runtime for `WorkspaceDefinition.mount(...)`.
 *
 * Lives in node-only code (it imports the bun:sqlite and filesystem
 * materializers); call it from a mount factory and hand the result to `.mount`:
 *
 * ```ts
 * import { nodeMountRuntime } from '@epicenter/workspace/node';
 *
 * export function zhongwen(opts: ZhongwenMountOptions = {}) {
 *   return zhongwenWorkspace.mount({
 *     name: 'zhongwen',
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
		bind: (ctx) => ({
			sqlite<
				TTables extends TablesRecord,
				TFts extends FtsConfig<TTables> | undefined = undefined,
			>(
				workspace: MaterializerInput<TTables>,
				options?: SqliteMountOptions<TTables, TFts>,
			) {
				return attachBunSqliteMaterializer<TTables, TFts>(workspace, {
					filePath: sqlitePath(ctx.epicenterRoot, workspace.ydoc.guid),
					fts: options?.fts,
					log: createLogger(`${ctx.mount}-sqlite`),
				});
			},
			markdown<TTables extends TablesRecord>(
				workspace: MaterializerInput<TTables>,
				{ tables, git }: MarkdownMountOptions<TTables>,
			) {
				const markdown = attachMarkdownExport<TTables>(workspace, {
					dir: ctx.epicenterRoot,
					tables,
					log: createLogger(`${ctx.mount}-markdown`),
				});
				if (git) {
					// Autosave the export's own subdirs: one per selected table, the
					// same `config.dir ?? name` the export writes to.
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
				return markdown;
			},
		}),
	};
}
