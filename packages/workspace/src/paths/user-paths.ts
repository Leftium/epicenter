import envPaths from 'env-paths';

const paths = envPaths('epicenter', { suffix: '' });

export const userConfigDir = paths.config;
export const userDataDir = paths.data;
export const userCacheDir = paths.cache;
export const userLogDir = paths.log;
