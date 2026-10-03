/**
 * EXPERIMENT: build the canonical editor callers page to `dist-canonical/`,
 * as a compile check. The output is disposable and not committed.
 *
 *     bun packages/folder/evidence/edit-handle/canonical-build.ts
 */
import { build } from 'vite';
import { canonicalViteConfig } from './canonical-dev.js';

await build(canonicalViteConfig());
