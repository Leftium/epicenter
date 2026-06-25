/**
 * The persisted choice of which Epicenter star this Opensidian install talks to
 * (ADR-0069: privacy is which deployment runs the program). Default is the
 * hosted cloud with no token (normal OAuth); a self-hoster overrides the base
 * URL and pastes a token their box minted.
 *
 * Plain localStorage, not a reactive store: `$platform/auth` reads it once,
 * synchronously, while constructing the auth client at module load. Changing the
 * instance writes here and reloads, so construction re-reads the new value. The
 * settings UI keeps its own form `$state` and never needs this to be reactive.
 */

import { type Instance, normalizeInstanceUrl } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';

const STORAGE_KEY = 'opensidian.instance';

/**
 * The hosted default: the build-time API origin with no token, so the app uses
 * the normal OAuth flow. Reverting to this is "use hosted Epicenter".
 */
export const defaultInstance: Instance = { baseURL: APP_URLS.API };

/** True when the instance is the hosted default (no override is in effect). */
export function isDefaultInstance(instance: Instance): boolean {
	return instance.baseURL === defaultInstance.baseURL && !instance.token;
}

/**
 * Read the persisted instance, falling back to the hosted default. A missing,
 * non-JSON, or unparseable record reads as the default rather than throwing, so
 * a bad write can never wedge the app at boot. The base URL is re-normalized on
 * read so a hand-edited record cannot smuggle in a malformed origin.
 */
export function readInstance(): Instance {
	if (typeof localStorage === 'undefined') return defaultInstance;
	const raw = localStorage.getItem(STORAGE_KEY);
	if (raw === null) return defaultInstance;
	try {
		const parsed = JSON.parse(raw) as Partial<Instance>;
		const { data: baseURL } = normalizeInstanceUrl(
			String(parsed.baseURL ?? ''),
		);
		if (!baseURL) return defaultInstance;
		const token =
			typeof parsed.token === 'string' && parsed.token.trim() !== ''
				? parsed.token
				: undefined;
		return { baseURL, token };
	} catch {
		return defaultInstance;
	}
}

/** Persist an instance. The caller reloads so auth construction re-reads it. */
export function writeInstance(instance: Instance): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(instance));
}

/** Forget the override and revert to the hosted default. */
export function clearInstance(): void {
	localStorage.removeItem(STORAGE_KEY);
}
