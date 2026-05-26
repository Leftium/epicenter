/**
 * Shared throw used by every `*.browser.ts` web stub of a Tauri-only
 * service. `(...args: unknown[]) => never` is structurally assignable to
 * any function signature (unknown is the top of the parameter lattice,
 * never is the bottom of the return lattice), so individual stubs can
 * drop the property in directly and use `satisfies` against the real
 * Tauri module type with zero casts.
 */
export function unreachable(..._args: unknown[]): never {
	throw new Error('Tauri-only service called from web bundle');
}
