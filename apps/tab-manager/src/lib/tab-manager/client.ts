import { openTabManager } from './extension';

export type TabManager = Awaited<ReturnType<typeof openTabManager>>;
