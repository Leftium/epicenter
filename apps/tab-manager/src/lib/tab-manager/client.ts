import { openTabManagerBrowser } from './extension';

export type TabManagerBrowser = Awaited<ReturnType<typeof openTabManagerBrowser>>;
