import { CapabilityRegistry } from '@numenjs/core'
import { OutboundHttpService } from '@numenjs/http'
import { LoggingService } from '@numenjs/logging'
import { Context } from 'cordis'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import rssIntegrationPlugin, { rssReadCapability, rssLimits, type RssReadInput, type RssReadOutput } from '../src/index.js'

const roots: Context[] = []
const servers: Server[] = []
const sockets = new Set<Socket>()
const timers: ReturnType<typeof setTimeout>[] = []
const rss = (body = '', attrs = '') => `<rss version="2.0" ${attrs}><channel><title>News</title>${body}</channel></rss>`
const atom = (body = '', attrs = '') => `<feed xmlns="http://www.w3.org/2005/Atom" ${attrs}><title>News</title>${body}</feed>`

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener)
  servers.push(server)
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TCP address required')
  return `http://127.0.0.1:${address.port}`
}
async function document(source: string | Buffer, headers: Record<string, string> = { 'content-type': 'application/rss+xml' }): Promise<string> {
  return serve((_request, response) => { response.writeHead(200, headers); response.end(source) })
}
async function setup(headers: Record<string, string> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LoggingService, { console: false, persist: false, levels: { base: 3 } })
  await ctx.plugin(CapabilityRegistry)
  await ctx.plugin(OutboundHttpService, { proxyAgentEnv: '', headers })
  const fork = ctx.plugin(rssIntegrationPlugin)
  await fork
  const provider = ctx.capabilities.resolveProvider<RssReadInput, RssReadOutput>(rssReadCapability)!
  const read = (input: RssReadInput, signal = new AbortController().signal) => Promise.resolve(provider.invoke({ input, signal, connections: {} }))
  return { ctx, fork, read }
}
afterEach(async () => {
  timers.splice(0).forEach(clearTimeout)
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('RSS Integration', () => {
  it('projects RSS 2, CDATA, entities, extensions and relative links while preserving item order and duplicate IDs', async () => {
    const url = await document(rss(`<link>/news</link><description>Updates &amp; notices</description><language>zh-CN</language>
      <lastBuildDate>Sun, 18 Oct 2026 12:00:00 GMT</lastBuildDate>
      <item xml:base="/posts/"><guid>same-id</guid><title>First &lt;one&gt;</title><link>first</link><pubDate>original-date</pubDate><dc:creator>Author</dc:creator><description><![CDATA[<b>summary</b>]]></description><c:encoded><![CDATA[<script>untrusted()</script>]]></c:encoded></item>
      <item><guid>same-id</guid><title>Second</title></item>`, 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:c="http://purl.org/rss/1.0/modules/content/"'))
    const { read } = await setup()
    const result = await read({ url })
    expect(result).toMatchObject({ format: 'rss2', feed: { title: 'News', link: `${url}/news`, description: 'Updates & notices', language: 'zh-CN' }, totalItems: 2, returnedItems: 2, truncated: false })
    expect(result.items[0]).toEqual({ id: 'same-id', title: 'First <one>', link: `${url}/posts/first`, published: 'original-date', updated: '', author: 'Author', summary: '<b>summary</b>', content: '<script>untrusted()</script>' })
    expect(result.items[1]?.id).toBe('same-id')
    expect((await read({ url })).items).toEqual(result.items)
  })

  it('supports prefixed Atom namespaces, inherited xml:base/lang, alternate links, XHTML text and author fallback', async () => {
    const url = await document(`<a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:fake="urn:fake" xml:base="/blog/" xml:lang="en">
      <a:title type="html">A &lt;b&gt;feed&lt;/b&gt;</a:title><a:subtitle>Read me</a:subtitle><a:author><a:name>Feed Author</a:name></a:author><a:updated>2026-10-18T00:00:00Z</a:updated>
      <a:link rel="self" href="feed.xml"/><a:link href="./"/>
      <a:entry xml:base="../posts/"><a:id>tag:example,2026:1</a:id><a:title>Real</a:title><fake:title>Wrong</fake:title><a:link href="one"/><a:published>source-time</a:published><a:updated>updated-time</a:updated><a:summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello <b>world</b>.</p></div></a:summary><a:content type="html">&lt;img src=x onerror=bad()&gt;</a:content></a:entry>
      <fake:entry><fake:title>Wrong entry</fake:title></fake:entry></a:feed>`, { 'content-type': 'application/atom+xml; charset="UTF-8"' })
    const { read } = await setup()
    const result = await read({ url })
    expect(result.feed).toEqual({ title: 'A <b>feed</b>', description: 'Read me', link: `${url}/blog/`, language: 'en', updated: '2026-10-18T00:00:00Z' })
    expect(result.items).toEqual([{ id: 'tag:example,2026:1', title: 'Real', link: `${url}/posts/one`, published: 'source-time', updated: 'updated-time', author: 'Feed Author', summary: 'Hello world.', content: '<img src=x onerror=bad()>' }])
  })

  it('reports truncation explicitly, keeps empty fields, and does not follow enclosure or external content URLs', async () => {
    let externalReads = 0
    const external = await serve((_req, res) => { externalReads++; res.end('must not be read') })
    const url = await document(atom(`<entry><id>a</id><link href="javascript:alert(1)"/><content src="${external}"/></entry><entry><id>a</id></entry>`))
    const { read } = await setup()
    expect(await read({ url, maxItems: 1 })).toMatchObject({ totalItems: 2, returnedItems: 1, truncated: true, items: [{ id: 'a', title: '', link: '', content: '' }] })
    expect(externalReads).toBe(0)
  })

  it('reads empty feeds and UTF-8 BOM documents and accepts missing or generic XML content types', async () => {
    const { read } = await setup()
    for (const type of ['', 'text/xml', 'application/xml', 'text/plain', 'application/octet-stream']) {
      const url = await document(`\uFEFF<?xml version="1.0" encoding="UTF-8"?>${rss()}`, type ? { 'content-type': type } : {})
      expect(await read({ url })).toMatchObject({ items: [], totalItems: 0, returnedItems: 0, truncated: false })
    }
  })

  it.each([
    ['mismatched tags', rss('<item></channel>'), 'RSS_XML_INVALID'],
    ['trailing second root', `${rss()}<other/>`, 'RSS_XML_INVALID'],
    ['unknown entity', rss('<description>&secret;</description>'), 'RSS_XML_INVALID'],
    ['DOCTYPE', `<!DOCTYPE rss SYSTEM "http://127.0.0.1:1/private">${rss()}`, 'RSS_DTD_FORBIDDEN'],
    ['internal entity expansion', `<!DOCTYPE rss [<!ENTITY a "explode"><!ENTITY b "&a;&a;">]>${rss('<description>&b;</description>')}`, 'RSS_XML_INVALID'],
    ['duplicate expanded attribute', rss('<item xmlns:a="urn:x" xmlns:b="urn:x" a:id="1" b:id="2"/>'), 'RSS_XML_INVALID'],
    ['unbound namespace', rss('<unknown:item/>'), 'RSS_XML_INVALID'],
    ['invalid namespace local name', rss('<a:1 xmlns:a="urn:x"/>'), 'RSS_XML_INVALID'],
    ['namespace rebinding', rss('', 'xmlns:xml="urn:wrong"'), 'RSS_XML_INVALID'],
    ['non-UTF-8 declaration', `<?xml version="1.0" encoding="ISO-8859-1"?>${rss()}`, 'RSS_ENCODING_UNSUPPORTED'],
    ['wrong RSS version', '<rss version="1.0"><channel/></rss>', 'RSS_FORMAT_UNSUPPORTED'],
    ['wrong Atom namespace', '<feed xmlns="urn:wrong"/>', 'RSS_FORMAT_UNSUPPORTED'],
    ['multiple channels', '<rss version="2.0"><channel/><channel/></rss>', 'RSS_XML_INVALID'],
    ['invalid base URL', atom('', 'xml:base="javascript:bad()"'), 'RSS_XML_INVALID'],
    ['invalid after truncated item', rss('<item/><item><title></item>'), 'RSS_XML_INVALID'],
  ])('rejects %s without leaking parser input', async (_label, source, code) => {
    const url = await document(source)
    const { read } = await setup()
    const error = await read({ url, maxItems: 1 }).catch(error => error)
    expect(error).toMatchObject({ code })
    expect(error.cause).toBeUndefined()
    expect(error.message).not.toContain(source)
  })

  it('never fetches external DTDs or entities', async () => {
    let externalReads = 0
    const external = await serve((_request, response) => { externalReads++; response.end('private local data') })
    const { read } = await setup()
    for (const source of [
      `<!DOCTYPE rss SYSTEM "${external}">${rss()}`,
      `<!DOCTYPE rss [<!ENTITY private SYSTEM "${external}">]>${rss('<description>&private;</description>')}`,
    ]) await expect(read({ url: await document(source) })).rejects.toMatchObject({ name: 'RssError' })
    expect(externalReads).toBe(0)
  })

  it.each([
    ['depth', rss('<x>'.repeat(40) + '</x>'.repeat(40))],
    ['elements', rss('<x/>'.repeat(rssLimits.maxElements))],
    ['feed item count', rss('<item/>'.repeat(rssLimits.maxFeedItems + 1))],
  ])('rejects excessive %s even when maxItems is one', async (_label, source) => {
    const { read } = await setup()
    await expect(read({ url: await document(source), maxItems: 1 })).rejects.toMatchObject({ code: 'RSS_LIMIT_EXCEEDED' })
  })

  it('bounds both streamed response bytes and expanded JSON output', async () => {
    const { read } = await setup()
    const oversized = await serve((_request, response) => { response.writeHead(200, { 'content-type': 'text/xml' }); response.write('<rss>'); response.end('x'.repeat(rssLimits.maxResponseBytes)) })
    await expect(read({ url: oversized })).rejects.toMatchObject({ code: 'RSS_RESPONSE_TOO_LARGE' })
    await expect(read({ url: await document(rss(`<description>${'\\'.repeat(600_000)}</description>`)) })).rejects.toMatchObject({ code: 'RSS_OUTPUT_TOO_LARGE' })
  })

  it('rejects declared oversized content before waiting for its body', async () => {
    const url = await serve((_request, response) => { response.writeHead(200, { 'content-length': rssLimits.maxResponseBytes + 1 }); response.flushHeaders() })
    const { read } = await setup()
    await expect(read({ url, timeoutMs: 500 })).rejects.toMatchObject({ code: 'RSS_RESPONSE_TOO_LARGE' })
  })

  it('rejects non-XML content types, invalid UTF-8 bytes and incompatible HTTP charset', async () => {
    const { read } = await setup()
    await expect(read({ url: await document(rss(), { 'content-type': 'text/html' }) })).rejects.toMatchObject({ code: 'RSS_MEDIA_TYPE_UNSUPPORTED' })
    await expect(read({ url: await document(Buffer.from([0xff, 0xfe, 0x41])) })).rejects.toMatchObject({ code: 'RSS_ENCODING_UNSUPPORTED' })
    await expect(read({ url: await document(rss(), { 'content-type': 'text/xml; charset=iso-8859-1' }) })).rejects.toMatchObject({ code: 'RSS_ENCODING_UNSUPPORTED' })
  })

  it('follows relative redirects and resolves links against the final URL without inheriting host credentials', async () => {
    const received: Record<string, string | string[] | undefined>[] = []
    const url = await serve((request, response) => {
      received.push(request.headers)
      if (request.url === '/start') { response.writeHead(302, { location: '/feed/feed.xml' }); response.end() }
      else { response.writeHead(200, { 'content-type': 'text/xml' }); response.end(rss('<link>home</link>')) }
    })
    const { ctx, read } = await setup({ Authorization: 'Bearer private-token', Cookie: 'session=private', 'X-Private': 'private-header' })
    expect((await read({ url: `${url}/start` })).feed.link).toBe(`${url}/feed/home`)
    expect(received).toHaveLength(2)
    for (const headers of received) {
      expect(headers.authorization).toBeUndefined()
      expect(headers.cookie).toBeUndefined()
      expect(headers['x-private']).toBeUndefined()
    }
    expect(ctx.http.config.headers?.Authorization).toBe('Bearer private-token')
  })

  it.each(['file:///etc/passwd', 'http://name:secret@example.com/feed', 'mailto:test@example.com'])('rejects unsafe redirect %s before a second request', async location => {
    let count = 0
    const url = await serve((_request, response) => { count++; response.writeHead(302, { location }); response.end() })
    const { read } = await setup()
    await expect(read({ url })).rejects.toMatchObject({ code: 'RSS_REDIRECT_INVALID' })
    expect(count).toBe(1)
  })

  it('rejects HTTPS downgrade redirects and a missing Location header', async () => {
    const { ctx, read } = await setup()
    ctx.on('http/fetch', async url => {
      expect(url.protocol).toBe('https:')
      return new Response('', { status: 302, headers: { location: 'http://example.test/feed' } })
    }, { prepend: true })
    await expect(read({ url: 'https://example.test/feed' })).rejects.toMatchObject({ code: 'RSS_REDIRECT_INVALID' })
    const other = await setup()
    const url = await serve((_request, response) => { response.writeHead(302); response.end() })
    await expect(other.read({ url })).rejects.toMatchObject({ code: 'RSS_REDIRECT_INVALID' })
  })

  it('bounds redirect loops and applies one timeout across every redirect', async () => {
    let count = 0
    const loop = await serve((_request, response) => { count++; response.writeHead(302, { location: '/again' }); response.end() })
    const { read } = await setup()
    await expect(read({ url: loop })).rejects.toMatchObject({ code: 'RSS_REDIRECT_LIMIT' })
    expect(count).toBe(rssLimits.maxRedirects + 1)
    const slow = await serve((_request, response) => { timers.push(setTimeout(() => { response.writeHead(302, { location: '/again' }); response.end() }, 60)) })
    await expect(read({ url: slow, timeoutMs: 100 })).rejects.toMatchObject({ code: 'RSS_TIMEOUT' })
  })

  it('times out while waiting for body bytes after successful response headers', async () => {
    const url = await serve((_request, response) => { response.writeHead(200, { 'content-type': 'text/xml' }); response.write('<rss>') })
    const { read } = await setup()
    await expect(read({ url, timeoutMs: 50 })).rejects.toMatchObject({ code: 'RSS_TIMEOUT' })
  })

  it('cancels active body reads, rejects pre-cancelled work and continues serving later calls', async () => {
    let ready!: () => void
    const waiting = new Promise<void>(resolve => { ready = resolve })
    const url = await serve((_request, response) => { response.writeHead(200, { 'content-type': 'text/xml' }); response.write('<rss>'); ready() })
    const { read } = await setup()
    const controller = new AbortController()
    const reading = read({ url }, controller.signal)
    const rejected = expect(reading).rejects.toMatchObject({ code: 'RSS_CANCELLED' })
    await waiting
    controller.abort(new Error('caller-private-reason'))
    await rejected
    await expect(read({ url }, controller.signal)).rejects.toMatchObject({ code: 'RSS_CANCELLED' })
    expect((await read({ url: await document(rss()) })).items).toEqual([])
  })

  it('unloading cancels active reads and makes previously resolved providers unavailable', async () => {
    let ready!: () => void
    const waiting = new Promise<void>(resolve => { ready = resolve })
    const url = await serve((_request, response) => { response.writeHead(200); response.write('<rss>'); ready() })
    const { fork, read } = await setup()
    const reading = read({ url })
    const rejected = expect(reading).rejects.toMatchObject({ code: 'RSS_UNAVAILABLE' })
    await waiting
    await fork.dispose()
    await rejected
    await expect(read({ url })).rejects.toMatchObject({ code: 'RSS_UNAVAILABLE' })
  })

  it('keeps URLs, server messages and transport causes out of errors and host logs', async () => {
    const url = await serve((_request, response) => { response.writeHead(403, 'private-feed-token'); response.end('private remote body') })
    const { ctx, read } = await setup()
    const error = await read({ url: `${url}/feed?access_key=private-feed-token` }).catch(error => error)
    expect(error).toMatchObject({ code: 'RSS_HTTP_ERROR' })
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain('private-feed-token')
    const logs = JSON.stringify(ctx.logs.query())
    expect(logs).not.toContain('private-feed-token')
    expect(logs).not.toContain(`${url}/feed`)
    expect(logs).not.toContain('private remote body')
  })

  it.each([{ url: 'file:///etc/passwd' }, { url: 'http://u:p@example.com' }, { url: 'not a URL' }, { url: 'http://example.test', maxItems: 0 }, { url: 'http://example.test', maxItems: 1001 }, { url: 'http://example.test', timeoutMs: Infinity }])('validates input before accessing transport: %j', async input => {
    const { ctx, read } = await setup()
    let requests = 0
    ctx.on('http/fetch', async () => { requests++; return new Response(rss()) }, { prepend: true })
    await expect(read(input)).rejects.toMatchObject({ name: 'RssError' })
    expect(requests).toBe(0)
  })
})
