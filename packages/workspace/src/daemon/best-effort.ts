import { Ok, tryAsync, trySync } from 'wellcrafted/result';

export function bestEffortSync(action: () => void): void {
	void trySync({
		try: action,
		catch: () => Ok(undefined),
	});
}

export async function bestEffortAsync(
	action: () => Promise<void>,
): Promise<void> {
	await tryAsync({
		try: action,
		catch: () => Ok(undefined),
	});
}
