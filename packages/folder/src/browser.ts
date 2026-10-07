/**
 * `@epicenter/folder/browser`: a folder in this browser's own storage, and
 * nothing else.
 *
 * The same `openFolder` and the same contract as `@epicenter/folder`, with
 * the choice already made. A build that imports this entry, or aliases the
 * bare specifier to it, carries no desktop adapter. Inside the desktop app
 * this opener refuses: that page's folder is a directory the shell owns.
 *
 * `downloadFolder` is this entry's alone: it makes a browser account folder
 * from its paired remote's history before the folder is first opened.
 *
 * Importing this module opens nothing.
 */
export {
	type DownloadError,
	type DownloadFolderOptions,
	downloadFolder,
	type FolderDownload,
	openFolder,
} from './browser-adapter.js';
export * from './contract.js';
export { DownloadFolderError } from './errors.js';
