import { parseXml, XmlDeclaration, XmlDocumentType, XmlElement, XmlText } from '@rgrove/parse-xml'
import { RssError, rssLimits, type RssFeed, type RssItem, type RssReadOutput } from './index.js'

const atom = 'http://www.w3.org/2005/Atom'
const xml = 'http://www.w3.org/XML/1998/namespace'
const xmlns = 'http://www.w3.org/2000/xmlns/'
const contentNamespace = 'http://purl.org/rss/1.0/modules/content/'
const dc = 'http://purl.org/dc/elements/1.1/'
interface ElementContext { namespace: string; local: string; base: URL; language: string }
// XML 1.0 NameStartChar without colon. parse-xml checks the remaining NameChars;
// namespace prefixes and local names additionally need their own valid start.
const ncNameStart = /^[A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}]/u

function qualifiedName(name: string): [string, string] {
  const parts = name.split(':')
  if (parts.length > 2 || parts.some(part => !ncNameStart.test(part))) throw new RssError('RSS_XML_INVALID')
  return parts.length === 2 ? [parts[0]!, parts[1]!] : ['', parts[0]!]
}

/** Namespace processing is separate from the parser's XML 1.0 well-formedness checks. */
function inspect(root: XmlElement, documentUrl: URL): Map<XmlElement, ElementContext> {
  const contexts = new Map<XmlElement, ElementContext>()
  const walk = (node: XmlElement, inherited: Map<string, string>, base: URL, language: string, depth: number): void => {
    if (depth > rssLimits.maxDepth || contexts.size >= rssLimits.maxElements) throw new RssError('RSS_LIMIT_EXCEEDED')
    const namespaces = new Map(inherited)
    for (const [name, value] of Object.entries(node.attributes)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        const prefix = name === 'xmlns' ? '' : qualifiedName(name)[1]
        if (prefix === 'xmlns' || value === xmlns || (prefix === 'xml') !== (value === xml)
          || (prefix !== '' && value === '')) throw new RssError('RSS_XML_INVALID')
        namespaces.set(prefix, value)
      }
    }
    const expandedAttributes = new Set<string>()
    for (const name of Object.keys(node.attributes)) {
      const [prefix, local] = qualifiedName(name)
      if (name === 'xmlns' || prefix === 'xmlns') continue
      if (prefix && !namespaces.has(prefix)) throw new RssError('RSS_XML_INVALID')
      const expanded = `${prefix ? namespaces.get(prefix) : ''}\u0000${local}`
      if (expandedAttributes.has(expanded)) throw new RssError('RSS_XML_INVALID')
      expandedAttributes.add(expanded)
    }
    const [prefix, local] = qualifiedName(node.name)
    if (prefix === 'xmlns' || (prefix && !namespaces.has(prefix))) throw new RssError('RSS_XML_INVALID')
    if (Object.hasOwn(node.attributes, 'xml:base')) {
      try {
        base = new URL(node.attributes['xml:base']!, base)
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error()
      } catch { throw new RssError('RSS_XML_INVALID') }
    }
    language = node.attributes['xml:lang'] ?? language
    contexts.set(node, { namespace: namespaces.get(prefix) ?? '', local, base, language })
    for (const child of node.children) if (child instanceof XmlElement) walk(child, namespaces, base, language, depth + 1)
  }
  walk(root, new Map([['xml', xml]]), documentUrl, '', 1)
  return contexts
}

export function projectFeed(source: string, documentUrl: URL, maxItems: number): RssReadOutput {
  let document: ReturnType<typeof parseXml>
  try { document = parseXml(source, { preserveDocumentType: true, preserveXmlDeclaration: true }) }
  catch (error) {
    // parse-xml builds a bounded in-memory tree recursively; an extreme nesting
    // overflow is rejected too, before we recurse through it for projection.
    throw new RssError(error instanceof RangeError ? 'RSS_LIMIT_EXCEEDED' : 'RSS_XML_INVALID')
  }
  for (const node of document.children) {
    if (node instanceof XmlDocumentType) throw new RssError('RSS_DTD_FORBIDDEN')
    if (node instanceof XmlDeclaration && (node.version !== '1.0' || (node.encoding && !/^utf-?8$/i.test(node.encoding)))) {
      throw new RssError('RSS_ENCODING_UNSUPPORTED')
    }
  }
  const root = document.root
  if (!root) throw new RssError('RSS_XML_INVALID')
  const contexts = inspect(root, documentUrl)
  const matches = (node: XmlElement, local: string, namespace = '') => {
    const context = contexts.get(node)!
    return context.local === local && context.namespace === namespace
  }
  const children = (node: XmlElement, local: string, namespace = '') => node.children.filter((child): child is XmlElement => child instanceof XmlElement && matches(child, local, namespace))
  const first = (node: XmlElement, local: string, namespace = '') => children(node, local, namespace)[0]
  const text = (node: XmlElement | undefined): string => {
    if (!node) return ''
    const collect = (element: XmlElement): string => element.children.map(child => child instanceof XmlElement ? collect(child) : child instanceof XmlText ? child.text : '').join('')
    return collect(node).trim()
  }
  const field = (node: XmlElement, name: string, namespace = '') => text(first(node, name, namespace))
  const link = (node: XmlElement | undefined, value: string): string => {
    if (!node || !value.trim()) return ''
    try {
      const url = new URL(value.trim(), contexts.get(node)!.base)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
    } catch { return '' }
  }
  const rssLink = (node: XmlElement) => { const element = first(node, 'link'); return link(element, text(element)) }
  const atomLink = (node: XmlElement): string => {
    const links = children(node, 'link', atom).filter(element => !element.attributes.rel || element.attributes.rel === 'alternate')
    for (const element of links) {
      const result = link(element, element.attributes.href ?? '')
      if (result) return result
    }
    return ''
  }
  const atomAuthor = (node: XmlElement) => { const author = first(node, 'author', atom); return author ? field(author, 'name', atom) : '' }
  const atomText = (node: XmlElement, name: string) => {
    const element = first(node, name, atom)
    if (!element || element.attributes.src) return ''
    const type = element.attributes.type ?? 'text'
    return ['text', 'html', 'xhtml'].includes(type) || type.startsWith('text/') ? text(element) : ''
  }

  let format: RssReadOutput['format']
  let feed: RssFeed
  let entries: XmlElement[]
  let project: (entry: XmlElement) => RssItem
  if (matches(root, 'rss') && root.attributes.version === '2.0') {
    const channels = children(root, 'channel')
    if (channels.length !== 1) throw new RssError('RSS_XML_INVALID')
    const channel = channels[0]!
    format = 'rss2'
    feed = { title: field(channel, 'title'), link: rssLink(channel), description: field(channel, 'description'), language: field(channel, 'language') || contexts.get(channel)!.language, updated: field(channel, 'lastBuildDate') || field(channel, 'pubDate') }
    entries = children(channel, 'item')
    project = entry => ({
      id: field(entry, 'guid'), title: field(entry, 'title'), link: rssLink(entry),
      published: field(entry, 'pubDate') || field(entry, 'date', dc), updated: '',
      author: field(entry, 'author') || field(entry, 'creator', dc),
      summary: field(entry, 'description'), content: field(entry, 'encoded', contentNamespace),
    })
  } else if (matches(root, 'feed', atom)) {
    format = 'atom'
    feed = { title: atomText(root, 'title'), link: atomLink(root), description: atomText(root, 'subtitle'), language: contexts.get(root)!.language, updated: field(root, 'updated', atom) }
    entries = children(root, 'entry', atom)
    project = entry => ({
      id: field(entry, 'id', atom), title: atomText(entry, 'title'), link: atomLink(entry),
      published: field(entry, 'published', atom), updated: field(entry, 'updated', atom),
      author: atomAuthor(entry) || atomAuthor(root), summary: atomText(entry, 'summary'), content: atomText(entry, 'content'),
    })
  } else throw new RssError('RSS_FORMAT_UNSUPPORTED')
  if (entries.length > rssLimits.maxFeedItems) throw new RssError('RSS_LIMIT_EXCEEDED')
  const items = entries.slice(0, maxItems).map(project)
  const output = { format, feed, items, totalItems: entries.length, returnedItems: items.length, truncated: entries.length > items.length }
  if (Buffer.byteLength(JSON.stringify(output)) > rssLimits.maxOutputBytes) throw new RssError('RSS_OUTPUT_TOO_LARGE')
  return output
}
