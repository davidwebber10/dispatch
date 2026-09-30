/**
 * The sorted secret names from a Doppler `/v3/configs/config/secrets/names` response.
 * Whatever a tool returns lands in the agent's transcript, so the list tool asks Doppler
 * for names only (no value leaves Doppler) and reads nothing but `names` here — and an
 * agent checks one secret at a time with doppler_get_secret (the value only on reveal).
 */
export function secretNames(body: unknown): string[] {
  const names = (body as { names?: unknown } | null | undefined)?.names;
  if (!Array.isArray(names)) return [];
  return names.filter((n): n is string => typeof n === 'string').sort();
}
