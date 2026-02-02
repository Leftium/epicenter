import { OsServiceLive } from '$lib/services/isomorphic/os';

export const IS_MACOS = OsServiceLive.type() === 'macos';
