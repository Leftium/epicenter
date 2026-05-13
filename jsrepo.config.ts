/**
 * jsrepo registry config for Epicenter app blocks.
 *
 * Each app under apps/<app>/blocks/ contributes recipe blocks that consumers
 * copy into their own tree with `bunx jsrepo add epicenter/<app>/<recipe>`.
 * The blocks depend on the npm primitives in @epicenter/workspace, the
 * @epicenter/<app> schema package root, and friends; consumers install those
 * normally. The blocks themselves are owned by the consumer once copied.
 */

import { defineConfig, js, repository } from 'jsrepo';

/**
 * Each app contributes one item per file under `apps/<app>/blocks/`. Fuji has
 * three (snapshot + script + daemon-route); the others have two (script +
 * daemon-route). jsrepo auto-detects cross-block imports as
 * `registryDependencies`, so a consumer running `bunx jsrepo add
 * epicenter/fuji/script` transitively pulls `epicenter/fuji/snapshot` and
 * `epicenter/fuji/daemon-route`.
 */

const BLOCKS = {
	fuji: ['workspace', 'snapshot', 'script', 'daemon-route'],
	honeycrisp: ['workspace', 'script', 'daemon-route'],
	opensidian: ['workspace', 'script', 'daemon-route'],
	zhongwen: ['workspace', 'script', 'daemon-route'],
} as const;

export default defineConfig({
	languages: [js()],
	registry: {
		name: '@epicenterhq/epicenter',
		version: 'package',
		homepage: 'https://epicenter.so',
		repository: 'https://github.com/EpicenterHQ/epicenter',
		items: Object.entries(BLOCKS).flatMap(([app, blocks]) =>
			blocks.map((block) => ({
				name: `epicenter/${app}/${block}`,
				type: 'block',
				files: [{ path: `apps/${app}/blocks/${block}.ts` }],
			})),
		),
		outputs: [repository()],
	},
});
