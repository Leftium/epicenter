import { createWorkspace } from '@epicenter/workspace';
import { whisperingKv, whisperingTables } from '$lib/workspace';

export function createWhisperingWorkspace() {
	return createWorkspace({
		id: 'whispering',
		tables: whisperingTables,
		kv: whisperingKv,
	});
}
