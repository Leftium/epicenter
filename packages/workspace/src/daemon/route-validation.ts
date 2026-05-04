import type { StartedDaemonRoute } from './types.js';

const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const OBJECT_DANGEROUS_ROUTE_KEYS = new Set([
	'__proto__',
	'prototype',
	'constructor',
]);

export function isValidDaemonRoute(route: string): boolean {
	return ROUTE_PATTERN.test(route) && !OBJECT_DANGEROUS_ROUTE_KEYS.has(route);
}

export function findDuplicateDaemonRoute(
	routes: readonly string[],
): string | null {
	const seen = new Set<string>();
	for (const route of routes) {
		if (seen.has(route)) return route;
		seen.add(route);
	}
	return null;
}

export function validateStartedDaemonRoutes(
	routes: readonly StartedDaemonRoute[],
):
	| { ok: true }
	| { ok: false; route: string; reason: 'invalid' | 'duplicate' } {
	const duplicate = findDuplicateDaemonRoute(
		routes.map((entry) => entry.route),
	);
	if (duplicate !== null) {
		return { ok: false, route: duplicate, reason: 'duplicate' };
	}
	for (const entry of routes) {
		if (!isValidDaemonRoute(entry.route)) {
			return { ok: false, route: entry.route, reason: 'invalid' };
		}
	}
	return { ok: true };
}
