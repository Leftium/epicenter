import * as Y from 'yjs';

export type DocumentDefinition<T extends object> = {
	id: string;
	bootstrap: (ydoc: Y.Doc) => T;
	/**
	 * Yjs garbage collection. Defaults to `false` because GC of deletion markers
	 * can break sync with peers that haven't seen the deletes yet — the safe
	 * choice for any doc that has more than one client. Set `true` for purely
	 * local, short-lived docs where memory pressure matters more than sync safety.
	 */
	gc?: boolean;
};

export type DocumentHandle<T extends object> = T & {
	ydoc: Y.Doc;
	dispose: () => void;
};

export function defineDocument<T extends object>(
	id: string,
	bootstrap: (ydoc: Y.Doc) => T,
	opts: { gc?: boolean } = {},
): DocumentDefinition<T> {
	return { id, bootstrap, gc: opts.gc };
}

export function openDocument<T extends object>(
	def: DocumentDefinition<T>,
): DocumentHandle<T> {
	const ydoc = new Y.Doc({ guid: def.id, gc: def.gc ?? false });
	try {
		const api = def.bootstrap(ydoc);
		return Object.assign(api, {
			ydoc,
			dispose: () => ydoc.destroy(),
		}) as DocumentHandle<T>;
	} catch (err) {
		// Partial bootstrap: fire 'destroy' so whatever registered first can clean up.
		ydoc.destroy();
		throw err;
	}
}
