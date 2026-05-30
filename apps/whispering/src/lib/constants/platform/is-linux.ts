import { OsServiceLive } from '#platform/os';

export const IS_LINUX = OsServiceLive.type() === 'linux';
