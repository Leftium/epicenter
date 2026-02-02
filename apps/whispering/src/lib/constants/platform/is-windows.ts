import { OsServiceLive } from '$lib/services/isomorphic/os';

export const IS_WINDOWS = OsServiceLive.type() === 'windows';
