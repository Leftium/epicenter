export const EPICENTER_CONFIG_FILENAME = 'epicenter.config.ts';

export const DEFAULT_EPICENTER_CONFIG_SOURCE = `// One folder is one app is one mount. Default-export the mount your app
// factory returns to bring this Epicenter folder online. For example:
//
//   import { honeycrisp } from '@epicenter/honeycrisp/mount';
//
//   export default honeycrisp();
//
// Until you add that export, \`epicenter daemon up\` will tell you no mount is
// declared yet.
`;
