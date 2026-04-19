import * as Y from 'yjs';

export type DocumentDefinition<T> = {
	id: string;
	bootstrap: (ydoc: Y.Doc) => T;
};

export type DocumentHandle<T> = T & {
	ydoc: Y.Doc;
	dispose: () => void;
};

export function defineDocument<T>(
	id: string,
	bootstrap: (ydoc: Y.Doc) => T,
): DocumentDefinition<T> {
	return { id, bootstrap };
}

export function openDocument<T>(def: DocumentDefinition<T>): DocumentHandle<T> {
	const ydoc = new Y.Doc({ guid: def.id, gc: false });
	try {
		const api = def.bootstrap(ydoc);
		return Object.assign(api as object, {
			ydoc,
			dispose: () => ydoc.destroy(),
		}) as DocumentHandle<T>;
	} catch (err) {
		// Partial bootstrap: fire 'destroy' so whatever registered first can clean up.
		ydoc.destroy();
		throw err;
	}
}
