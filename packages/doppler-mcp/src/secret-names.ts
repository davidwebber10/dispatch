/**
 * The sorted secret names from a Doppler `/v3/configs/config/secrets` response.
 * That response carries every secret's raw and computed value, and whatever a tool
 * returns lands in the agent's transcript — so the list tool returns only these names,
 * and an agent reads one value at a time with doppler_get_secret.
 */
export function secretNames(body: unknown): string[] {
  const secrets = (body as { secrets?: unknown } | null | undefined)?.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return [];
  return Object.keys(secrets).sort();
}
