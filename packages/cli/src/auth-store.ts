// packages/cli/src/auth-store.ts
import { join } from 'node:path';

interface AuthState {
  remoteUrl: string;
  token: string;
  expiresAt: string;
  user?: { id: string; email: string; name?: string };
}

export function authFilePath(home: string): string {
  return join(home, 'auth.json');
}

export async function loadAuth(home: string): Promise<AuthState | null> {
  const file = Bun.file(authFilePath(home));
  if (!(await file.exists())) return null;
  return file.json() as Promise<AuthState>;
}

export async function saveAuth(home: string, state: AuthState): Promise<void> {
  await Bun.write(authFilePath(home), JSON.stringify(state, null, 2));
}

export async function clearAuth(home: string): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  try { await unlink(authFilePath(home)); } catch {}
}

export type { AuthState };
