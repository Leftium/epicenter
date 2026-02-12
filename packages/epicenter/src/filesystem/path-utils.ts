/**
 * Resolve a POSIX-style path the same way `path.resolve` does in Node:
 * absolute paths are used as-is, relative paths are joined onto `base`,
 * and `.` / `..` segments are normalized away.
 */
export function posixResolve(base: string, path: string): string {
	const resolved = path.startsWith('/')
		? path
		: base.replace(/\/$/, '') + '/' + path;
	const parts = resolved.split('/');
	const stack: string[] = [];
	for (const part of parts) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			stack.pop();
		} else {
			stack.push(part);
		}
	}
	return '/' + stack.join('/');
}
