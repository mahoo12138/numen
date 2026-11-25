import type { ConnectionAdapterDefinition, ConnectionTypeDefinition } from '@numenjs/connections'
import { defineCapability, type NumenValue, type CapabilityProvider } from '@numenjs/core'
import type { CredentialTypeDefinition } from '@numenjs/credentials'
import type { Context } from 'cordis'
import z from 'schemastery'
import { createGithubApiRuntime, githubApiLimits, GithubApiError, githubOwnerPattern, githubRepoPattern, githubTokenPattern,
  type GithubApiRuntime, type GithubIssueGetInput, type GithubIssueCreateInput, type GithubIssueCommentInput, type GithubIssueOutput, type GithubCommentOutput } from './api-runtime.js'

export * from './api-runtime.js'

export const githubTokenCredential: CredentialTypeDefinition = {
  id: 'github:token', version: 1, title: 'GitHub API Token',
  secret: z.object({ token: z.string().pattern(githubTokenPattern).role('secret').required().description('Personal access token for selected repositories. Reading requires Issues: read; creating issues or comments requires Issues: write. Stored encrypted.') }),
}
export const githubApiConnectionType: ConnectionTypeDefinition<GithubApiRuntime> = { id: 'github:api', version: 1, title: 'GitHub API' }
export const githubTokenAdapter: ConnectionAdapterDefinition<Record<string, NumenValue>, GithubApiRuntime> = {
  id: 'github:token', version: 1, title: 'GitHub API Token', type: githubApiConnectionType, credentialType: githubTokenCredential.id, config: z.object({}),
}
const repositoryFields = () => ({
  owner: z.string().pattern(githubOwnerPattern).required().description('Repository owner or organization name.'),
  repo: z.string().pattern(githubRepoPattern).required().description('Repository name without .git; GitHub.com only.'),
})
const issueNumber = () => z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required()
const issueOutput = z.object({
  id: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(), number: issueNumber(), title: z.string().required(), body: z.string().required(),
  state: z.union([z.const('open'), z.const('closed')]).required(), url: z.string().required(),
})
const connections = [{ name: 'api', required: true, accepts: ['github:api@1'] }]
export const githubIssueGetCapability = defineCapability<GithubIssueGetInput, GithubIssueOutput>({
  id: 'github:issue-get', version: 1, kind: 'query', title: 'Get GitHub Issue',
  description: 'Read one GitHub.com issue by repository and number. The GitHub Issues API also accepts pull request numbers.',
  input: z.object({ ...repositoryFields(), issueNumber: issueNumber() }), output: issueOutput, connections,
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})
export const githubIssueCreateCapability = defineCapability<GithubIssueCreateInput, GithubIssueOutput>({
  id: 'github:issue-create', version: 1, kind: 'action', title: 'Create GitHub Issue',
  description: 'Create a GitHub.com issue. A timeout may leave the outcome uncertain; failed writes are not automatically retried.',
  input: z.object({ ...repositoryFields(), title: z.string().min(1).max(256).required(), body: z.string().max(githubApiLimits.maxBodyCharacters).role('numen/multiline') }),
  output: issueOutput, connections, semantics: { sideEffect: true, idempotent: false, retrySafe: false },
})
export const githubIssueCommentCapability = defineCapability<GithubIssueCommentInput, GithubCommentOutput>({
  id: 'github:issue-comment', version: 1, kind: 'action', title: 'Comment on GitHub Issue',
  description: 'Add a Markdown comment to a GitHub.com issue or pull request. Failed writes are not automatically retried.',
  input: z.object({ ...repositoryFields(), issueNumber: issueNumber(), body: z.string().min(1).max(githubApiLimits.maxBodyCharacters).role('numen/multiline').required() }),
  output: z.object({ id: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(), body: z.string().required(), url: z.string().required() }),
  connections, semantics: { sideEffect: true, idempotent: false, retrySafe: false },
})

export function githubApiPlugin(ctx: Context): void {
  ctx.credentials.defineType(ctx, githubTokenCredential)
  ctx.connections.defineType(ctx, githubApiConnectionType)
  ctx.connections.defineAdapter(ctx, githubTokenAdapter)
  ctx.connections.provideAdapter(ctx, githubTokenAdapter, { async open({ credential, signal }) {
    if (!credential) throw new GithubApiError('GITHUB_API_UNAVAILABLE')
    return createGithubApiRuntime(ctx, credential.value, signal)
  } })
  ctx.capabilities.define(ctx, githubIssueGetCapability)
  ctx.capabilities.define(ctx, githubIssueCreateCapability)
  ctx.capabilities.define(ctx, githubIssueCommentCapability)
  const runtime = (connections: Readonly<Record<string, unknown>>): GithubApiRuntime => {
    const api = connections.api as GithubApiRuntime | undefined
    if (!api || typeof api.getIssue !== 'function' || typeof api.createIssue !== 'function' || typeof api.commentOnIssue !== 'function') throw new GithubApiError('GITHUB_API_UNAVAILABLE')
    return api
  }
  ctx.capabilities.provide(ctx, githubIssueGetCapability, { async invoke({ input, connections, signal }) { return runtime(connections).getIssue(input, signal) } } satisfies CapabilityProvider<GithubIssueGetInput, GithubIssueOutput>)
  ctx.capabilities.provide(ctx, githubIssueCreateCapability, { async invoke({ input, connections, signal }) { return runtime(connections).createIssue(input, signal) } } satisfies CapabilityProvider<GithubIssueCreateInput, GithubIssueOutput>)
  ctx.capabilities.provide(ctx, githubIssueCommentCapability, { async invoke({ input, connections, signal }) { return runtime(connections).commentOnIssue(input, signal) } } satisfies CapabilityProvider<GithubIssueCommentInput, GithubCommentOutput>)
}
githubApiPlugin.inject = ['capabilities', 'credentials', 'connections', 'http']
