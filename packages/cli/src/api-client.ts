import { treaty } from '@elysiajs/eden';
import type { LocalApp } from '@epicenter/server';

const DEFAULT_PORT = 3913;
const DEFAULT_URL = `http://localhost:${DEFAULT_PORT}`;

export function createApiClient(baseUrl = DEFAULT_URL) {
	return treaty<LocalApp>(baseUrl);
}

export type ApiClient = ReturnType<typeof createApiClient>;

export async function assertServerRunning(
	baseUrl = DEFAULT_URL,
): Promise<void> {
	try {
		const response = await fetch(baseUrl, {
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) throw new Error(`Server responded with ${response.status}`);
	} catch (cause) {
		const error = new Error(
			`No Epicenter server running on ${baseUrl}.\nStart one with: epicenter serve`,
		);
		error.cause = cause;
		throw error;
	}
}
