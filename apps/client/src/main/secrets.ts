/**
 * OS keychain storage (ADDENDUM A3.1, A8.2): macOS Keychain, Windows
 * Credential Manager, Secret Service on Linux. Tokens, the device key and the
 * cache key live only here; nothing secret is written to disk by the app.
 */
export interface SecretStore {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

export type SecretName = 'session' | 'device-key' | 'cache-key';

export const DEFAULT_KEYCHAIN_SERVICE = 'ai.verafy.henge';

export class KeyringStore implements SecretStore {
  constructor(private readonly service = DEFAULT_KEYCHAIN_SERVICE) {}

  private async entry(name: SecretName) {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry(this.service, name);
  }
  async get(name: SecretName) {
    return (await this.entry(name)).getPassword() ?? null;
  }
  async set(name: SecretName, value: string) {
    (await this.entry(name)).setPassword(value);
  }
  async delete(name: SecretName) {
    try {
      (await this.entry(name)).deletePassword();
    } catch {
      // Already absent.
    }
  }
}

/** For unit tests only. */
export class MemoryStore implements SecretStore {
  readonly map = new Map<SecretName, string>();
  async get(name: SecretName) {
    return this.map.get(name) ?? null;
  }
  async set(name: SecretName, value: string) {
    this.map.set(name, value);
  }
  async delete(name: SecretName) {
    this.map.delete(name);
  }
}
