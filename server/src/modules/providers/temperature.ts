import type { ProviderError } from './errors.js';

// Mémoire du processus (non persistée) des modèles qui refusent le paramètre `temperature`.
const refusing = new Set<string>();

const key = (providerId: string, model: string) => `${providerId}\u0000${model}`;

export function acceptsTemperature(providerId: string, model: string): boolean {
  return !refusing.has(key(providerId, model));
}

export function rememberNoTemperature(providerId: string, model: string): void {
  refusing.add(key(providerId, model));
}

/** Le fournisseur a refusé la requête à cause de `temperature` (statut 400 mentionnant le paramètre). */
export function isTemperatureRejection(err: ProviderError): boolean {
  return err.status === 400 && /temperature/i.test(err.detail);
}

/** Pour les tests. */
export function resetTemperatureMemory(): void {
  refusing.clear();
}
