import { Service, type Context } from 'cordis'

/**
 * Runtime clock and identity seam. Durable execution needs both to be
 * substitutable: recovery and timeout semantics can only be asserted
 * deterministically when time and identifiers are supplied by the host.
 *
 * Core is also bundled into the browser Workbench, so this module must stay
 * free of Node built-ins; Web Crypto is global in Node 22 and browsers.
 */
export interface Clock {
  now(): Date
  nowIso(): string
  nowMs(): number
}

declare module 'cordis' {
  interface Context {
    clock: SystemClock
  }
}

export class SystemClock extends Service implements Clock {
  constructor(ctx: Context) {
    super(ctx, 'clock')
  }

  now(): Date {
    return new Date()
  }

  nowIso(): string {
    return new Date().toISOString()
  }

  nowMs(): number {
    return Date.now()
  }
}

/** Used by services that must also run in a bare Context (unit fixtures). */
const fallback: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
}

/**
 * Optional lookup: Cordis throws on undeclared service property access, so a bare
 * Context (unit fixtures) must still get a usable clock without declaring inject.
 */
export function clockOf(ctx: Context): Clock {
  return ctx.get('clock') ?? fallback
}

/** Stable identifier shape: `<prefix>_<uuid without dashes>`. */
export function nextId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '')}`
}

export default SystemClock
