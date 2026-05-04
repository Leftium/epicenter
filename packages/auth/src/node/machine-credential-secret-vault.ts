export type MachineCredentialSecretRef = {
	service: string;
	account: string;
};

export type MachineCredentialSecretVault = {
	kind: 'plaintextFile' | 'systemKeychain';
	isAvailable(): Promise<boolean>;
	selfTest(): Promise<void>;
	save(ref: MachineCredentialSecretRef, value: string): Promise<void>;
	load(ref: MachineCredentialSecretRef): Promise<string | null>;
	delete(ref: MachineCredentialSecretRef): Promise<void>;
};

export function createPlaintextMachineCredentialSecretVault(): MachineCredentialSecretVault {
	return {
		kind: 'plaintextFile',
		async isAvailable() {
			return true;
		},
		async selfTest() {},
		async save() {},
		async load() {
			return null;
		},
		async delete() {},
	};
}

async function loadKeyring() {
	return await import('@napi-rs/keyring');
}

export function createSystemKeychainMachineCredentialSecretVault(): MachineCredentialSecretVault {
	return {
		kind: 'systemKeychain',
		async isAvailable() {
			try {
				const { Entry } = await loadKeyring();
				return typeof Entry === 'function';
			} catch {
				return false;
			}
		},
		async selfTest() {
			const { Entry } = await loadKeyring();
			const ref = {
				service: 'epicenter.auth.selfTest',
				account: crypto.randomUUID(),
			};
			const entry = new Entry(ref.service, ref.account);
			try {
				entry.setPassword('ok');
				const value = entry.getPassword();
				if (value !== 'ok') throw new Error('OS keychain self-test failed.');
			} finally {
				try {
					entry.deletePassword();
				} catch {}
			}
		},
		async save(ref, value) {
			const { Entry } = await loadKeyring();
			new Entry(ref.service, ref.account).setPassword(value);
		},
		async load(ref) {
			const { Entry } = await loadKeyring();
			return new Entry(ref.service, ref.account).getPassword();
		},
		async delete(ref) {
			const { Entry } = await loadKeyring();
			try {
				new Entry(ref.service, ref.account).deletePassword();
			} catch {}
		},
	};
}
