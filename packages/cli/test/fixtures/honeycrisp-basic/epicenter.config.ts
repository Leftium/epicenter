/**
 * Honeycrisp workspace client — e2e test fixture.
 *
 * Imports the factory from the honeycrisp app's isomorphic export.
 * This is what a real `epicenter.config.ts` looks like when consuming
 * a published workspace definition.
 */

import { createHoneycrisp } from '@epicenter/honeycrisp/workspace';

export const honeycrisp = createHoneycrisp();
