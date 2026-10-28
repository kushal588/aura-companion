import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../storage';

/**
 * API key handling (PLAN §12.2, §8.6).
 *
 * Desktop: the key is written to the OS credential store (Windows Credential
 * Manager / Secret Service / Keychain) through Rust and never returns to the
 * renderer. Requests go through the native gateway, so the key stays out of the
 * WebView entirely.
 *
 * Web/WebView development: the key is kept in memory for the session only. It is
 * deliberately *not* written to localStorage — a browser fallback cannot offer a
 * secure store, and pretending otherwise would be worse than asking again.
 */

export interface CredentialStatus {
  hasKey: boolean;
  /** Where the key is stored, shown verbatim in Settings. */
  location: 'os_keychain' | 'session_memory';
  /** True when the key can only be used for this session. */
  ephemeral: boolean;
}

export interface CredentialStore {
  status(): Promise<CredentialStatus>;
  /** Store or replace the key. Never logged, never returned. */
  setKey(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Only the web fallback can return the key; the native store cannot. */
  getKeyForRendererView(): string | undefined;
  /** Key/credential for a request: the native gateway signs it server-side. */
  authKind(): 'native' | 'inline';
}

class NativeCredentialStore implements CredentialStore {
  private cachedStatus: CredentialStatus = { hasKey: false, location: 'os_keychain', ephemeral: false };

  async status(): Promise<CredentialStatus> {
    const hasKey = await invoke<boolean>('credentials_has_gemini_key');
    this.cachedStatus = { hasKey, location: 'os_keychain', ephemeral: false };
    return this.cachedStatus;
  }

  async setKey(key: string): Promise<void> {
    await invoke('credentials_set_gemini_key', { secret: key.trim() });
    this.cachedStatus = { hasKey: true, location: 'os_keychain', ephemeral: false };
  }

  async clear(): Promise<void> {
    await invoke('credentials_clear_gemini_key');
    this.cachedStatus = { hasKey: false, location: 'os_keychain', ephemeral: false };
  }

  getKeyForRendererView(): string | undefined {
    return undefined;
  }

  authKind(): 'native' | 'inline' {
    return 'native';
  }
}

class SessionCredentialStore implements CredentialStore {
  private key?: string;

  async status(): Promise<CredentialStatus> {
    return {
      hasKey: Boolean(this.key),
      location: 'session_memory',
      ephemeral: true,
    };
  }

  async setKey(key: string): Promise<void> {
    this.key = key.trim();
    if (!this.key) this.key = undefined;
  }

  async clear(): Promise<void> {
    this.key = undefined;
  }

  getKeyForRendererView(): string | undefined {
    return this.key;
  }

  authKind(): 'native' | 'inline' {
    return 'inline';
  }
}

export function createCredentialStore(): CredentialStore {
  return isTauriRuntime() ? new NativeCredentialStore() : new SessionCredentialStore();
}

export function describeCredentialLocation(status: CredentialStatus): string {
  if (status.location === 'os_keychain') {
    return 'Stored in your operating system credential store. AURA never writes it to a file or the database.';
  }
  return 'Held in memory for this session only. Browser preview mode cannot use a secure key store, so the key is asked for again after a reload.';
}
