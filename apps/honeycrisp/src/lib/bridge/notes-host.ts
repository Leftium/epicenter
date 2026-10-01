/**
 * A `NotesHost` over the folder bridge. The desktop leaf supplies a transport
 * bound to the page's own origin; tests supply one bound to a host's `fetch`.
 */
import type { GitSnapshot } from '@epicenter/app/files';
import type { NotesFolder, NotesHost } from '../platform/types.js';
import type {
	FaultState,
	FileRevision,
	HostInfo,
	TerminalReply,
} from './contract.js';
import type { BridgeTransport } from './transport.js';

export async function openBridgeNotesHost(
	transport: BridgeTransport,
): Promise<NotesHost> {
	const lifetime = new AbortController();
	const [info, snapshot] = await Promise.all([
		transport.app<HostInfo>({ op: 'info' }),
		transport.call(['git', 'snapshot'], []),
	]);
	let gitSnapshot = snapshot;
	const gitListeners = new Set<(snapshot: GitSnapshot) => void>();
	const folder: NotesFolder = {
		tables: {
			notes: {
				list: () => transport.call(['tables', 'notes', 'list'], []),
				get: (...args) => transport.call(['tables', 'notes', 'get'], args),
				create: (...args) =>
					transport.call(['tables', 'notes', 'create'], args),
				update: (...args) =>
					transport.call(['tables', 'notes', 'update'], args),
				writeSource: (...args) =>
					transport.call(['tables', 'notes', 'writeSource'], args),
				rename: (...args) =>
					transport.call(['tables', 'notes', 'rename'], args),
				delete: (...args) =>
					transport.call(['tables', 'notes', 'delete'], args),
			},
			folders: {
				list: () => transport.call(['tables', 'folders', 'list'], []),
				get: (...args) => transport.call(['tables', 'folders', 'get'], args),
				create: (...args) =>
					transport.call(['tables', 'folders', 'create'], args),
				update: (...args) =>
					transport.call(['tables', 'folders', 'update'], args),
				delete: (...args) =>
					transport.call(['tables', 'folders', 'delete'], args),
			},
		},
		files: {
			list: () => transport.call(['files', 'list'], []),
			read: (...args) => transport.call(['files', 'read'], args),
			write: (...args) => transport.call(['files', 'write'], args),
			remove: (...args) => transport.call(['files', 'remove'], args),
			move: (...args) => transport.call(['files', 'move'], args),
			mkdir: (...args) => transport.call(['files', 'mkdir'], args),
			rmdir: (...args) => transport.call(['files', 'rmdir'], args),
		},
		git: {
			get snapshot() {
				return gitSnapshot;
			},
			subscribe(listener) {
				gitListeners.add(listener);
				listener(gitSnapshot);
				return () => gitListeners.delete(listener);
			},
			status: () => transport.call(['git', 'status'], []),
			commit: (...args) => transport.call(['git', 'commit'], args),
			log: (...args) => transport.call(['git', 'log'], args),
		},
	};
	const changeListeners = new Set<() => void>();
	const closeListeners = new Set<() => void>();
	let closePending = false;
	function deliverClose() {
		if (!closePending || closeListeners.size === 0) return;
		closePending = false;
		void transport.app({ op: 'closeReceived' }).catch(() => {});
		for (const listener of closeListeners) listener();
	}

	transport.listen((event) => {
		switch (event.type) {
			case 'git':
				gitSnapshot = event.snapshot;
				for (const listener of gitListeners) listener(gitSnapshot);
				break;
			case 'files':
			// A dropped stream may have missed changes; reread to be sure.
			case 'reconnected':
				for (const listener of changeListeners) listener();
				break;
			case 'closeRequested':
				closePending = true;
				deliverClose();
				break;
		}
	}, lifetime.signal);

	let cwd = info.root;
	const shown = (path: string) =>
		path === info.root
			? '/'
			: path.startsWith(`${info.root}/`)
				? path.slice(info.root.length)
				: path;

	return {
		folder,
		terminal: {
			get cwd() {
				return shown(cwd);
			},
			description: `/bin/sh in ${info.root} · the same files, real git`,
			async exec(command) {
				const reply = await transport.app<TerminalReply>({
					op: 'terminal',
					command,
					cwd,
				});
				cwd = reply.cwd;
				return reply;
			},
		},
		location: info.root,
		reveal: () => transport.app<string | undefined>({ op: 'reveal' }),
		history: {
			log: (path, depth) =>
				transport.app<FileRevision[]>({ op: 'fileLog', path, depth }),
			show: (oid, path) => transport.app<string>({ op: 'show', oid, path }),
		},
		faults: info.faults
			? {
					get: () => transport.app<FaultState>({ op: 'faults' }),
					set: (faults) =>
						transport.app<FaultState>({ op: 'setFaults', faults }),
				}
			: undefined,
		onExternalChange(listener) {
			changeListeners.add(listener);
			return () => changeListeners.delete(listener);
		},
		onCloseRequested(listener) {
			closeListeners.add(listener);
			if (closePending) queueMicrotask(deliverClose);
			return () => closeListeners.delete(listener);
		},
		async quit() {
			await transport.app({ op: 'quit' });
		},
		async close() {
			lifetime.abort();
		},
	};
}
