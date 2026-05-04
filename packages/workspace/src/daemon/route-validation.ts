const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Route names become object keys in `/list` action manifests.
const RESERVED_OBJECT_ROUTE_KEYS = new Set([
	'__proto__',
	'prototype',
	'constructor',
]);

export type DaemonRouteNameIssue = {
	route: string;
	reason: 'invalid' | 'duplicate';
};

export function isValidDaemonRoute(route: string): boolean {
	return ROUTE_PATTERN.test(route) && !RESERVED_OBJECT_ROUTE_KEYS.has(route);
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

export function validateDaemonRouteNames(
	routes: readonly string[],
): DaemonRouteNameIssue | null {
	const duplicate = findDuplicateDaemonRoute(routes);
	if (duplicate !== null) {
		return { route: duplicate, reason: 'duplicate' };
	}
	for (const route of routes) {
		if (!isValidDaemonRoute(route)) {
			return { route, reason: 'invalid' };
		}
	}
	return null;
}
