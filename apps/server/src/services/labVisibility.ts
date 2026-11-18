/**
 * Whether this actor may see result values on a lab order.
 *
 * Patients (and their guardians) see nothing until VERIFIED. Clinicians and lab staff
 * see results as soon as they exist — acting on an unverified critical value is the
 * whole point of alerting them.
 *
 * Its own module so every surface that shows results — the lab module and the AI
 * explainer alike — applies the one rule without importing the lab service's
 * dependencies.
 */
export function canSeeResults(actorRole: string, status: string): boolean {
  if (actorRole === "PATIENT") return status === "VERIFIED";
  return true;
}
