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

const APPS = ['fuji', 'honeycrisp', 'opensidian', 'zhongwen'] as const;
const BLOCKS = ['script', 'daemon-route'] as const;

export default defineConfig({
	languages: [js()],
	registry: {
		name: '@epicenterhq/epicenter',
		version: 'package',
		homepage: 'https://epicenter.so',
		repository: 'https://github.com/EpicenterHQ/epicenter',
		items: APPS.flatMap((app) =>
			BLOCKS.map((block) => ({
				name: `epicenter/${app}/${block}`,
				type: 'block',
				files: [{ path: `apps/${app}/blocks/${block}.ts` }],
			})),
		),
		outputs: [repository()],
	},
});
