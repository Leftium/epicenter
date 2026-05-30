import { OsServiceLive } from '#platform/os';

export const IS_WINDOWS = OsServiceLive.type() === 'windows';
