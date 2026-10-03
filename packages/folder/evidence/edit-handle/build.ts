/**
 * EXPERIMENT: build the demo page to `dist/`, as a compile check.
 *
 *     bun packages/folder/evidence/edit-handle/build.ts
 *
 * The built page still needs the server in `dev.ts` for its folder.
 */
import { build } from 'vite';
import { demoViteConfig } from './vite-config.js';

await build(demoViteConfig());
