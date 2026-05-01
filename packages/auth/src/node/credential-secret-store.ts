export type CredentialSecretRef = {
	service: string;
	account: string;
};

export type CredentialSecretStore = {
	kind: 'file' | 'osKeychain';
	isAvailable(): Promise<boolean>;
	selfTest(): Promise<void>;
	save(ref: CredentialSecretRef, value: string): Promise<void>;
	load(ref: CredentialSecretRef): Promise<string | null>;
	delete(ref: CredentialSecretRef): Promise<void>;
};

export function createFileSecretStore(): CredentialSecretStore {
	return {
		kind: 'file',
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

export function createKeychainSecretStore(): CredentialSecretStore {
	return {
		kind: 'osKeychain',
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
