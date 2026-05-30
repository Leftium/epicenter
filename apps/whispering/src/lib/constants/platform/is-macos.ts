import { OsServiceLive } from '#platform/os';

export const IS_MACOS = OsServiceLive.type() === 'macos';
