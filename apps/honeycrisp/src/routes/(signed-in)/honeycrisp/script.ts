import { createMachineAuthClient } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { attachSync, type ProjectDir, toWsUrl } from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

export async function openHoneycrisp({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
}: {
	projectDir?: ProjectDir;
	clientID?: number;
}) {
	const auth = await createMachineAuthClient();
	const doc = openHoneycrispDoc({
		clientID,
		getKeys: () => {
			if (auth.state.status !== 'signed-in') {
				throw new Error(
					'[honeycrisp-script] machine auth is not signed-in; cannot read encryption keys.',
				);
			}
			return auth.state.identity.encryptionKeys;
		},
	});
	const yjsLog = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
		bearerToken: () => auth.bearerToken,
	});
	const rpc = sync.attachRpc(doc.actions);

	return { ...doc, yjsLog, sync, rpc };
}
