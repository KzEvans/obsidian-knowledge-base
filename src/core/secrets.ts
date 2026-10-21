import type { App } from 'obsidian';

export const SECRET_IDS = {
  mineru: 'paper-workbench-mineru-token',
  dashscope: 'paper-workbench-dashscope-key',
} as const;

/** Secret ids of the plugins this one replaces; read once for migration, never written. */
export const LEGACY_SECRET_IDS = {
  mineru: 'pdf-reading-mode-mineru-api-token',
  dashscope: 'pdf-selection-translator-qwen-api-key',
} as const;

export type SecretName = keyof typeof SECRET_IDS;

export interface SecretAccess {
  get(name: SecretName): string | null;
  set(name: SecretName, value: string): void;
}

export function createSecretAccess(app: App): SecretAccess {
  return {
    get: name => {
      const value = app.secretStorage.getSecret(SECRET_IDS[name])?.trim() || null;
      registerSecretForRedaction(value);
      return value;
    },
    set: (name, value) => {
      app.secretStorage.setSecret(SECRET_IDS[name], value.trim());
      registerSecretForRedaction(value);
    },
  };
}

/** Copy secrets from the old plugins when this plugin has none yet. Returns the names copied. */
export function importLegacySecrets(app: App): SecretName[] {
  const copied: SecretName[] = [];
  for (const name of Object.keys(SECRET_IDS) as SecretName[]) {
    if (app.secretStorage.getSecret(SECRET_IDS[name])?.trim()) continue;
    const legacy = app.secretStorage.getSecret(LEGACY_SECRET_IDS[name])?.trim();
    if (!legacy) continue;
    app.secretStorage.setSecret(SECRET_IDS[name], legacy);
    copied.push(name);
  }
  return copied;
}

const knownSecrets = new Set<string>();

export function registerSecretForRedaction(value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed && trimmed.length >= 8) knownSecrets.add(trimmed);
}

const SIGNED_QUERY = /([?&](?:X-Amz-[A-Za-z-]+|Signature|Expires|OSSAccessKeyId|Security-Token|x-oss-[a-z-]+|token|sig|key)=)[^&#\s"']+/gi;

/** Remove anything that could be a credential from text bound for logs, notices or the store. */
export function redact(text: string): string {
  let result = text;
  for (const secret of knownSecrets) result = result.split(secret).join('[已隐藏]');
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[已隐藏]')
    .replace(SIGNED_QUERY, '$1[已隐藏]');
}

export function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
