/**
 * Shared formatting utilities for tab display.
 */

import { Ok, trySync } from 'wellcrafted/result';

/**
 * Extract the hostname from a URL string.
 *
 * Returns the original string if URL parsing fails (e.g. chrome:// URLs).
 *
 * @example
 * ```typescript
 * getDomain('https://github.com/foo') // 'github.com'
 * getDomain('chrome://extensions')    // 'chrome://extensions'
 * ```
 */
export function getDomain(url: string): string {
	const { data } = trySync({
		try: () => new URL(url).hostname,
		catch: () => Ok(url),
	});
	return data;
}

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * @example
 * ```typescript
 * getRelativeTime(Date.now() - 60_000)    // '1m ago'
 * getRelativeTime(Date.now() - 3_600_000) // '1h ago'
 * ```
 */
export function getRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return 'Just now';
}
