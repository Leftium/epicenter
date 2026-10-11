/**
 * `@epicenter/folder/tauri`: a folder owned by the desktop shell, and nothing
 * else.
 *
 * The same `openFolder` and the same contract as `@epicenter/folder`, with
 * the choice already made. A build that imports this entry, or aliases the
 * bare specifier to it, carries no browser storage and no Git
 * implementation. Outside the desktop app this opener refuses; it never
 * opens browser storage instead.
 *
 * The shell installs the `tauri-plugin-epicenter-folder` crate, registers
 * each folder's directory under an ID, and grants windows access. Importing
 * this module does none of that and opens nothing.
 */
export * from './contract.js';
export { openFolder } from './tauri-adapter.js';
