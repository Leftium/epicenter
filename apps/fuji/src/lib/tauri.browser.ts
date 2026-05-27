export const tauri = null;

export function requireTauri(): never {
	throw new Error('requireTauri() called outside Tauri runtime');
}
