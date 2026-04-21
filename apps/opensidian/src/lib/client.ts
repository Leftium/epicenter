/**
 * Opensidian workspace client — a single `defineDocument` closure that owns
 * the Y.Doc construction and composes every attachment inline.
 *
 * Mirrors the fuji prototype: no `defineWorkspace` / `Object.assign` dance.
 * App-specific wiring (file-content docs, sqlite index, virtual filesystem,
 * bash emulator, and all actions) is constructed inside the closure so every
 * piece binds to the same `ydoc` / `tables` instance.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	defineDocument,
	toWsUrl,
} from '@epicenter/document';
import {
	createFileContentDocs,
	createSqliteIndex,
	createYjsFileSystem,
} from '@epicenter/filesystem';
import { skillsDocument } from '@epicenter/skills';
import { createPersistedState } from '@epicenter/svelte';
import { AuthSession, createAuth } from '@epicenter/svelte/auth';
import {
	attachEncryption,
	attachKv,
	attachTables,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { Bash } from 'just-bash';
import Type from 'typebox';
import * as Y from 'yjs';
import { opensidianTables } from './workspace/definition';

const session = createPersistedState({
	key: 'opensidian:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

const opensidianFactory = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const tables = attachTables(ydoc, opensidianTables);
		const kv = attachKv(ydoc, {});
		const enc = attachEncryption(ydoc, { tables, kv });

		const fileContentDocs = createFileContentDocs({
			workspaceId: id,
			filesTable: tables.helpers.files,
		});
		const sqliteIndex = createSqliteIndex(fileContentDocs)({
			tables: tables.helpers,
		});
		const fs = createYjsFileSystem(tables.helpers.files, fileContentDocs);
		const bash = new Bash({ fs, cwd: '/' });

		const actions = {
			files: {
				search: defineQuery({
					title: 'Search Notes',
					description:
						'Search notes by content using full-text search. Returns matching file paths and content snippets.',
					input: Type.Object({
						query: Type.String({ description: 'The search query string' }),
					}),
					handler: async ({ query }) => sqliteIndex.exports.search(query),
				}),
				read: defineQuery({
					title: 'Read File',
					description:
						'Read the full content of a file by its absolute path (e.g. "/notes/meeting.md").',
					input: Type.Object({
						path: Type.String({
							description: 'Absolute file path starting with /',
						}),
					}),
					handler: async ({ path }) => {
						const content = await fs.readFile(path);
						const MAX_LENGTH = 50_000;

						if (content.length > MAX_LENGTH) {
							return {
								content: content.slice(0, MAX_LENGTH),
								truncated: true,
								totalLength: content.length,
								note: `Content truncated at ${MAX_LENGTH} chars. Use bash head/tail for specific sections.`,
							};
						}

						return { content, truncated: false };
					},
				}),
				list: defineQuery({
					title: 'List Directory',
					description:
						'List files and folders in a directory. Use "/" for the root.',
					input: Type.Object({
						path: Type.Optional(
							Type.String({ description: 'Directory path. Defaults to "/"' }),
						),
					}),
					handler: async ({ path }) => {
						const entries = await fs.readdir(path ?? '/');
						return { entries };
					},
				}),
				write: defineMutation({
					title: 'Write File',
					description:
						'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
					input: Type.Object({
						path: Type.String({ description: 'Absolute file path' }),
						content: Type.String({ description: 'The content to write' }),
					}),
					handler: async ({ path, content }) => {
						await fs.writeFile(path, content);
						return { success: true, path };
					},
				}),
				create: defineMutation({
					title: 'Create File',
					description: 'Create a new empty file at the given path.',
					input: Type.Object({
						path: Type.String({
							description: 'Absolute file path for the new file',
						}),
					}),
					handler: async ({ path }) => {
						await fs.writeFile(path, '');
						return { success: true, path };
					},
				}),
				delete: defineMutation({
					title: 'Delete File',
					description: 'Delete a file or directory at the given path.',
					input: Type.Object({
						path: Type.String({ description: 'Absolute path to delete' }),
					}),
					handler: async ({ path }) => {
						await fs.rm(path);
						return { success: true, path };
					},
				}),
				move: defineMutation({
					title: 'Move/Rename File',
					description: 'Move or rename a file from one path to another.',
					input: Type.Object({
						src: Type.String({ description: 'Current file path' }),
						dst: Type.String({ description: 'New file path' }),
					}),
					handler: async ({ src, dst }) => {
						await fs.mv(src, dst);
						return { success: true, from: src, to: dst };
					},
				}),
				mkdir: defineMutation({
					title: 'Create Directory',
					description: 'Create a new directory at the given path.',
					input: Type.Object({
						path: Type.String({ description: 'Absolute directory path' }),
					}),
					handler: async ({ path }) => {
						await fs.mkdir(path);
						return { success: true, path };
					},
				}),
			},
			bash: {
				exec: defineMutation({
					title: 'Execute Bash Command',
					description:
						'Execute a bash command against the virtual filesystem. Supports standard Unix commands (ls, cat, grep, echo, etc.).',
					input: Type.Object({
						command: Type.String({
							description: 'The bash command to execute',
						}),
					}),
					handler: async ({ command }) => {
						const result = await bash.exec(command);
						return {
							stdout: result.stdout,
							stderr: result.stderr,
							exitCode: result.exitCode,
						};
					},
				}),
			},
		};

		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);
		const sync = attachSync(ydoc, {
			url: (workspaceId) =>
				toWsUrl(`${APP_URLS.API}/workspaces/${workspaceId}`),
			getToken: async () => auth.token,
			waitFor: idb.whenLoaded,
		});

		return {
			id,
			ydoc,
			tables: tables.helpers,
			kv: kv.helper,
			enc,
			idb,
			sync,
			fileContentDocs,
			sqliteIndex: sqliteIndex.exports,
			fs,
			bash,
			actions,
			batch: (fn: () => void) => ydoc.transact(fn),
			whenReady: idb.whenLoaded,
			whenDisposed: Promise.all([
				idb.whenDisposed,
				sync.whenDisposed,
				enc.whenDisposed,
			]).then(() => {}),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: Number.POSITIVE_INFINITY },
);

export const workspace = opensidianFactory.open('epicenter.opensidian');

/** Per-file content Y.Doc factory — re-exported from the main workspace. */
export const fileContentDocs = workspace.fileContentDocs;

/** Yjs-backed virtual filesystem with path-based operations. */
export const fs = workspace.fs;

/**
 * Shell emulator backed by the Yjs virtual filesystem.
 *
 * Executes `just-bash` commands against the same `fs` used by the UI,
 * so files created via `echo "x" > /foo.md` are immediately visible
 * in the file tree. Shell state (env, cwd) resets between `exec()` calls.
 */
export const bash = workspace.bash;

/**
 * Global skills workspace — ecosystem-wide skills shared across all Epicenter apps.
 *
 * This is a SEPARATE workspace from the main opensidian workspace. It uses its own
 * Yjs document (`epicenter.skills`) with its own IndexedDB persistence. Skills are
 * imported via the CLI (`epicenter skills import`) or the dedicated skills app, then
 * synced to all Epicenter apps via the skills workspace CRDT.
 *
 * The skills workspace provides read actions for progressive skill disclosure:
 * - `listSkills()` — catalog (id, name, description) — cheap, no docs opened
 * - `getSkill({ id })` — metadata + instructions — opens one Y.Doc
 * - `getSkillWithReferences({ id })` — full skill with all references
 */
export const skillsWorkspace = skillsDocument.open('epicenter.skills');
export const skillInstructionsDocs = skillsWorkspace.instructionsDocs;
export const skillReferenceDocs = skillsWorkspace.referenceDocs;

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.enc.applyKeys(session.encryptionKeys);
		workspace.sync.reconnect();
	},
	async onLogout() {
		await workspace.idb.clearLocal();
		window.location.reload();
	},
});

/** AI tool representations for the opensidian workspace. */
export const workspaceAiTools = actionsToAiTools(workspace.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;
