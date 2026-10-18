/** Stable across revisions; each segment is encoded independently. */
export function webhookPath(automationId: string, triggerId: string): string {
  return `/api/webhooks/${encodeURIComponent(automationId)}/${encodeURIComponent(triggerId)}`
}
