/** Stable across revisions; each path segment is encoded independently. */
export function githubWebhookPath(automationId: string, triggerId: string): string {
  return `/api/github/webhooks/${encodeURIComponent(automationId)}/${encodeURIComponent(triggerId)}`
}
