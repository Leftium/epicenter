/**
 * Honeycrisp workspace client — e2e test fixture.
 *
 * Imports the definition and factory directly from the honeycrisp app's
 * isomorphic exports. This is what a real `epicenter.config.ts` looks like
 * when consuming a published workspace definition.
 */

import { createHoneycrisp } from '@epicenter/honeycrisp/workspace';
import { honeycrisp } from '@epicenter/honeycrisp/definition';

export { honeycrisp as definition };

export default createHoneycrisp();
