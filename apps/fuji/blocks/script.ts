import {
	connectFujiDaemonActions,
	DEFAULT_FUJI_DAEMON_ROUTE,
} from './daemon-route.js';
import { type OpenFujiSnapshotOptions, openFujiSnapshot } from './snapshot.js';

export async function openFujiScript({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	projectDir,
	clientID,
	loadOfflineEncryptionKeys,
}: OpenFujiSnapshotOptions & { route?: string } = {}) {
	const snapshot = await openFujiSnapshot({
		projectDir,
		clientID,
		loadOfflineEncryptionKeys,
	});
	const actions = await connectFujiDaemonActions({ route, projectDir });

	return {
		tables: snapshot.tables,
		actions,
		async [Symbol.asyncDispose]() {
			snapshot[Symbol.dispose]();
		},
	};
}

export type FujiScript = Awaited<ReturnType<typeof openFujiScript>>;
