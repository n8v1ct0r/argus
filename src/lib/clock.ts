// "Now" for the server. ARGUS_NOW freezes the clock (ISO string or epoch ms) so the demo seed,
// screenshots, and e2e tests replay the same 24 hours every run.
export function nowMs(): number {
  const frozen = process.env.ARGUS_NOW;
  if (!frozen) return Date.now();
  const asNumber = Number(frozen);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(frozen);
  if (Number.isNaN(parsed)) throw new Error(`ARGUS_NOW is not a date: ${frozen}`);
  return parsed;
}
