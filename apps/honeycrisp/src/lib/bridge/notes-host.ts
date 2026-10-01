/**
 * A `NotesHost` over the folder bridge. The desktop leaf supplies a transport
 * bound to the page's own origin; tests supply one bound to a host's `fetch`.
 */
import type { GitSnapshot } from '@epicenter/app/files';
import { FOLDERS, NOTES } from '../data.js';
import type { NotesFolder, NotesHost } from '../platform/types.js';
import type {
	FaultState,
	FileRevision,
	HostInfo,
	TerminalReply,
} from './contract.js';
import { type BridgeTransport, createRemoteFolder } from './folder-client.js';

export async function openBridgeNotesHost(
	transport: BridgeTransport,
): Promise<NotesHost> {
	const lifetime = new AbortController();
	const [info, snapshot] = await Promise.all([
		transport.app<HostInfo>({ op: 'info' }),
		transport.call(['git', 'snapshot'], []) as Promise<GitSnapshot>,
	]);
	const folder = createRemoteFolder<NotesFolder>(transport, {
		tables: [NOTES, FOLDERS],
		snapshot,
		signal: lifetime.signal,
	});
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
				folder.receiveSnapshot(event.snapshot as GitSnapshot);
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
