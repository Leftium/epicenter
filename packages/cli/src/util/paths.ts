import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolution order: --home flag > EPICENTER_HOME env > ~/.epicenter/ */
export function resolveEpicenterHome(flagValue?: string): string {
	return flagValue ?? Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}
