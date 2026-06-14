// A mount name is a config-supplied identifier (carried on the Mount itself).
// It becomes the prefix of `/list` manifest keys and daemon action paths
// (`${mount}.${action}`), and the visible projection folder name, so it must
// exclude `.` (the mount boundary and the reserved-sibling marker) and start
// with an alphanumeric. The leading-character class also rejects `__proto__`
// and other underscore-led names.
//
// One Epicenter root declares exactly one mount, so there is no cross-mount
// uniqueness to enforce here: a config cannot collide with itself. Format is
// the only concern, and `loadEpicenterConfig` owns the check because it is the
// only place that can point the error at the offending file.
const MOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidMountName(name: string): boolean {
	return MOUNT_NAME_PATTERN.test(name);
}
