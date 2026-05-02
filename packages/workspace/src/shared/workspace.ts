import type * as Y from 'yjs';
import type { SyncControl } from '../document/attach-sync.js';

export type Workspace = Disposable & {
	readonly id: string;
	readonly ydoc: Y.Doc;
	readonly whenReady?: Promise<unknown>;
};

export type BrowserWorkspace = Workspace & {
	readonly syncControl: SyncControl;
	clearLocalData(): Promise<void>;
};
