import type * as Y from 'yjs';

export type Workspace = Disposable & {
	readonly id: string;
	readonly ydoc: Y.Doc;
	readonly whenReady?: Promise<unknown>;
};

export type BrowserWorkspace = Workspace & {
	clearLocalData(): Promise<void>;
};
