#!/usr/bin/env node
/* ==========================================================================
   tusk-apply.mjs: write published content into built HTML files.

   One file, plain Node 18 or newer, no packages. For sites that are plain
   HTML, or whose templates you would rather not touch. Run it after the
   build, over the folder of finished pages, once tusk-pull.mjs has written
   .tusk/published.json:

     node tusk-pull.mjs && node tusk-apply.mjs dist
     node tusk-apply.mjs dist path/to/published.json     (another snapshot)

   For every .html file under the folder it works out the page key
   (index.html is home, about/index.html or about.html is about, or
   data-tusk-page on <body>) and rewrites each marked element in place:

     data-tusk="page.field" (or "field")   text        the element's text (a <meta>'s
                                                       content attribute; a <title>'s text)
                                           textarea    one <p> per paragraph
                                           html        safe inline markup (explicit mark only)
                                           link        the link's words and href
                                           embed       an iframe's or video's src (https)
                                           toggle      the `hidden` attribute, off when shown
                                           photos      the first photo's src and alt
                                                       (a wrapper: one <img> per photo; an
                                                       element with no <img> and an inline
                                                       background-image: that style)
                                           file        the link's href
     data-tusk-list / data-tusk-item /     list        the first item is cloned for
     data-tusk-field="name"                            every entry, its parts filled

   When the snapshot carries `schema` (the scanner's field specs), fields
   found without a mark are written by their recorded `bind.selector` too:
   #id, .class, tag, :nth-of-type(n), the child combinator ">" and the
   descendant combinator (a space). A mark always wins over a bind. Files are
   rewritten only when something changed. Exits 1 with a plain reason when
   the folder or the snapshot is missing.

   When the snapshot carries `badge` (the studio is on Tusk's Free plan), a
   small "Edited with Tusk" link is written just before </body> on every
   page this script rewrites: inline markup and styles, no script, nothing
   fetched at page-view time. When the snapshot has no badge (a paid plan),
   any badge a previous build left is removed. The link is the studio's own
   referral link, so sign-ups from it earn the studio a commission.
   ========================================================================== */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/* Errors are thrown and reported once at the bottom, exit code 1. */
const fail = (msg) => { throw new Error(msg) }
const dir = process.argv[2]
const snapFile = path.resolve(process.argv[3] || '.tusk/published.json')
let snap = null

/* ---------- a small HTML tree that remembers where everything is -------- */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null, start: 0, openEnd: 0, closeStart: html.length, end: html.length }
  const stack = [root]
  TOKEN.lastIndex = 0
  for (let m; (m = TOKEN.exec(html));) {
    if (m[1]) { /* end tag: close up to the matching open element, ignore a stray one */
      const tag = m[1].toLowerCase()
      const i = stack.findLastIndex((n) => n.tag === tag)
      if (i > 0) { while (stack.length > i + 1) { const n = stack.pop(); n.closeStart = n.end = m.index } const n = stack.pop(); n.closeStart = m.index; n.end = m.index + m[0].length }
      continue
    }
    if (!m[2]) continue
    const tag = m[2].toLowerCase(), attrs = {}
    for (let a; (a = ATTR.exec(m[3]));) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? ''
    const node = { tag, attrs, children: [], parent: stack[stack.length - 1], start: m.index, openEnd: TOKEN.lastIndex, closeStart: TOKEN.lastIndex, end: TOKEN.lastIndex }
    node.parent.children.push(node)
    if (tag === 'script' || tag === 'style') { /* raw text: jump past it */
      const close = html.toLowerCase().indexOf('</' + tag, TOKEN.lastIndex)
      node.closeStart = close < 0 ? html.length : close; node.end = close < 0 ? html.length : html.indexOf('>', close) + 1
      TOKEN.lastIndex = node.end; continue
    }
    if (!VOID.has(tag) && !m[4]) stack.push(node)
  }
  return root
}
const all = (node, out = []) => { for (const c of node.children) { out.push(c); all(c, out) } return out }
const inner = (html, n) => html.slice(n.openEnd, n.closeStart)
const outer = (html, n) => html.slice(n.start, n.end)
const closest = (n, pred) => { for (let p = n.parent; p; p = p.parent) if (pred(p)) return p; return null }

/* ---------- the selector subset the scanner writes --------------------- */

function compile(sel) {
  const parts = [], re = /\s*(>)\s*|\s+/g
  let last = 0, comb = ' '
  for (let m; (m = re.exec(sel));) { parts.push({ comb, simple: sel.slice(last, m.index) }); comb = m[1] ? '>' : ' '; last = re.lastIndex }
  parts.push({ comb, simple: sel.slice(last) })
  return parts.filter((p) => p.simple).map((p) => {
    const c = { comb: p.comb, tag: null, id: null, classes: [], nth: null, attrs: [] }
    /* tag, #id, .class, :nth-of-type(n) and [name="value"] (the scanner's
       selector for a <meta name="description">; the value in double quotes) */
    p.simple.replace(/^([\w-]+)|#([\w-]+)|\.([\w-]+)|:nth-of-type\((\d+)\)|\[([\w-]+)(?:="([^"]*)")?\]/g, (_, t, i, k, n, an, av) => { if (t) c.tag = t.toLowerCase(); if (i) c.id = i; if (k) c.classes.push(k); if (n) c.nth = +n; if (an) c.attrs.push([an.toLowerCase(), av]); return '' })
    return c
  })
}
const classesOf = (n) => (n.attrs.class || '').split(/\s+/).filter(Boolean)
const matchSimple = (n, c) =>
  !(c.tag && n.tag !== c.tag) && !(c.id && n.attrs.id !== c.id) && c.classes.every((k) => classesOf(n).includes(k)) &&
  c.attrs.every(([a, v]) => a in n.attrs && (v === undefined || n.attrs[a] === v)) &&
  !(c.nth && n.parent && n.parent.children.filter((s) => s.tag === n.tag).indexOf(n) + 1 !== c.nth)
function matches(n, parts, i = parts.length - 1, scope = null) {
  if (!matchSimple(n, parts[i])) return false
  if (i === 0) return true
  if (parts[i].comb === '>') return !!n.parent && n.parent !== scope && matches(n.parent, parts, i - 1, scope)
  for (let p = n.parent; p && p !== scope; p = p.parent) if (matches(p, parts, i - 1, scope)) return true
  return false
}
const select = (scope, sel) => { try { const parts = compile(sel); return parts.length ? all(scope).filter((n) => matches(n, parts, parts.length - 1, scope)) : [] } catch { return [] } }

/* ---------- values ------------------------------------------------------- */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => esc(s).replace(/"/g, '&quot;')

/* ---------- the inline-HTML sanitiser -----------------------------------
   The one place stored content becomes markup again rather than text: a
   data-tusk-kind="html" field. Client HTML is untrusted, so it is reduced to
   a small set of inline, non-scripting tags before it is written into the
   built page. This is the same allow-list and algorithm as src/scan.ts and
   public/editor/tusk-preview.js — keep the three in step. Text is escaped
   (without double-encoding existing entities); <script>/<style>/<svg> and
   kin are dropped with their contents; any other tag is unwrapped; no on*
   handlers, no style attribute, and an href only when it cannot run. */
const HTML_ALLOWED = {
  a: ['href', 'target', 'rel', 'title'], span: ['title'], b: [], strong: [], i: [], em: [], u: [], s: [],
  small: [], sup: [], sub: [], mark: [], code: [], abbr: ['title'], time: ['datetime'], q: ['cite'],
  br: [], wbr: [], del: [], ins: [],
}
const HTML_COMMON_ATTRS = ['class', 'lang', 'dir']
const HTML_DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base', 'frame', 'frameset', 'applet', 'title', 'head'])
const HTML_VOID = new Set(['br', 'wbr'])
const safeInlineUrl = (u) => {
  const bare = String(u).replace(/[\u0000-\u0020\u007f]/g, '')
  if (!bare) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return /^(https?|mailto|tel):/i.test(bare) ? String(u).trim() : null
  return String(u).trim()
}
const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
const escText = (t) => t.replace(/&(?!#?[a-zA-Z0-9]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escInlineAttr = (t) => escText(t).replace(/"/g, '&quot;')
function sanitizeInlineHtml(input) {
  const s = String(input == null ? '' : input)
  if (!s) return ''
  let out = '', last = 0, dropName = '', dropDepth = 0
  const open = []
  const emitText = (t) => { if (t && !dropDepth) out += escText(t) }
  TAG_RE.lastIndex = 0
  for (let m; (m = TAG_RE.exec(s));) {
    emitText(s.slice(last, m.index))
    last = TAG_RE.lastIndex
    const tag = m[2] ? m[2].toLowerCase() : ''
    if (!tag) continue /* a comment: dropped */
    const closing = m[1] === '/', selfClose = m[4] === '/'
    if (dropDepth) {
      if (HTML_DROP_WITH_CONTENT.has(tag)) { if (closing) { if (tag === dropName && --dropDepth === 0) dropName = '' } else if (!selfClose) dropDepth++ }
      continue
    }
    if (HTML_DROP_WITH_CONTENT.has(tag)) { if (!closing && !selfClose) { dropName = tag; dropDepth = 1 } continue }
    const allowed = HTML_ALLOWED[tag]
    if (!allowed) continue /* unwrap: tag discarded, its text kept */
    if (closing) {
      const i = open.lastIndexOf(tag)
      if (i >= 0) { for (let k = open.length - 1; k >= i; k--) out += '</' + open[k] + '>'; open.length = i }
      continue
    }
    let attrs = '', hasTarget = false
    ATTR_RE.lastIndex = 0
    for (let a; (a = ATTR_RE.exec(m[3] || ''));) {
      const name = a[1].toLowerCase()
      if (name === 'rel') continue
      if (HTML_COMMON_ATTRS.indexOf(name) === -1 && allowed.indexOf(name) === -1) continue
      let val = a[2] ?? a[3] ?? a[4] ?? ''
      if (name === 'href') { const u = safeInlineUrl(val); if (!u) continue; val = u }
      if (name === 'target') hasTarget = true
      attrs += ' ' + name + '="' + escInlineAttr(val) + '"'
    }
    if (hasTarget) attrs += ' rel="noopener noreferrer"'
    if (HTML_VOID.has(tag)) { out += '<' + tag + attrs + '>'; continue }
    if (selfClose) { out += '<' + tag + attrs + '></' + tag + '>'; continue }
    out += '<' + tag + attrs + '>'
    open.push(tag)
  }
  emitText(s.slice(last))
  for (let k = open.length - 1; k >= 0; k--) out += '</' + open[k] + '>'
  return out
}
const media = (id) => { if (id === null || id === undefined) return null; const raw = typeof id === 'object' ? id.id : id; return (snap.media || {})[String(raw)] || null }
const isLink = (v) => !!v && typeof v === 'object' && !('id' in v) && typeof v.url === 'string' && /^https?:\/\/\S+$/i.test(v.url)
/* a photos entry is a media id or { photo: id, alt } as the editor stores it */
const photoEntries = (v) => (Array.isArray(v) ? v : []).map((e) => { const m = media(e && typeof e === 'object' ? e.photo ?? e.id : e); return m ? { url: m.url, alt: (e && typeof e === 'object' && e.alt) || m.alt || '' } : null }).filter(Boolean)
const looksLikePhotos = (v) => Array.isArray(v) && v.every((e) => e === null || typeof e !== 'object' || Object.keys(e).every((k) => ['photo', 'alt', 'id'].includes(k)))
const fieldValue = (pageKey, ref) => {
  const parts = ref.split('.'), key = parts.length > 1 ? parts.shift() : pageKey
  let cur = snap.pages && snap.pages[key] ? snap.pages[key].content : undefined
  for (const p of parts) cur = cur && typeof cur === 'object' ? cur[p] : undefined
  return cur === '' ? undefined : cur
}
/* a link field's value is { text, href } (either may be missing); a bare
   string is the older words-only value and still edits the words */
const isLinkValue = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && ('href' in v || 'text' in v) && !('url' in v) && !('id' in v)
const EMBED_TAGS = new Set(['iframe', 'video', 'audio'])
/* An address a client typed into a link: http(s), mailto:, tel: or relative;
   nothing that can run (same rule as the inline sanitiser's href). */
const safeLinkUrl = (u) => safeInlineUrl(u)
/* An embed src: https only. A map or a video player never comes over http. */
const safeEmbedUrl = (u) => { const s = String(u == null ? '' : u).replace(/[\u0000- \u007f]/g, ''); return /^https:\/\/[^/]/i.test(s) ? String(u).trim() : null }
const BG_URL_RE = /(background(?:-image)?\s*:[^;]*?url\(\s*)(['"]?)([^'")]*)\2(\s*\))/i
const kindOf = (n, value, forced) => {
  /* `html` and `toggle` are only ever the developer's explicit data-tusk-kind,
     never inferred: one writes markup back rather than text, the other hides
     a part of the page. */
  if (['text', 'textarea', 'photos', 'photo', 'file', 'list', 'html', 'link', 'embed', 'toggle'].includes(forced)) return forced === 'photo' ? 'photos' : forced
  if (n.tag === 'img' || n.tag === 'picture' || n.tag === 'figure') return 'photos'
  if (EMBED_TAGS.has(n.tag)) return 'embed'
  if (Array.isArray(value)) return looksLikePhotos(value) ? 'photos' : 'list'
  if (n.tag === 'a' && isLinkValue(value)) return 'link'
  if (n.tag === 'a' && (isLink(value) || typeof value !== 'string')) return 'file'
  if (n.tag === 'meta' || n.tag === 'title') return 'text'
  if (typeof value === 'string' && (/\n\s*\n/.test(value) || n.children.some((c) => c.tag === 'p') || /^(div|section|article|blockquote)$/.test(n.tag))) return 'textarea'
  return 'text'
}

/* ---------- list items: which entry an item is, and an empty part -------- */

/* What a list item's part is, as src/scan.ts inferSubKind reads it. */
const subKindOf = (n) => {
  const forced = (n.attrs['data-tusk-kind'] || '').toLowerCase()
  if (forced === 'photo' || forced === 'photos') return 'photo'
  if (forced === 'text' || forced === 'textarea' || forced === 'link') return forced
  if (n.tag === 'img' || n.tag === 'picture' || n.tag === 'figure') return 'photo'
  if (n.tag === 'a' && n.attrs.href && !/^#/.test(n.attrs.href) && !/\.(pdf|docx?|xlsx?|zip)(\?|$)/i.test(n.attrs.href)) return 'link'
  return n.children.some((c) => c.tag === 'p') ? 'textarea' : 'text'
}
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (w, e) => e[0] === '#' ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10) || 32) : ENTITY[e.toLowerCase()] ?? ' ')
/* An element's words as the scanner stores them: its own text when it wraps
   inline children (see valueFor in src/scan.ts), all of it otherwise. */
function ownText(html, n) {
  let s = ''
  if (n.children.length) { let pos = n.openEnd; for (const c of n.children) { s += html.slice(pos, c.start) + ' '; pos = c.end } s += html.slice(pos, n.closeStart) }
  else s = inner(html, n)
  return decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}
/* Each item's entry id, worked out exactly as the scanner made it: the slug
   of the first text sub-field, else item-N, with a clash given -N. */
function itemIds(itemParts, specSubs) {
  const firstText = (specSubs.find((s) => s.kind === 'text') || {}).id
  const seen = new Set()
  return itemParts.map((parts, i) => {
    const p = firstText ? parts.find((x) => x.id === firstText) : parts.find((x) => x.kind === 'text')
    let id = (p ? slug(p.text).slice(0, 32) : '') || 'item-' + (i + 1)
    while (seen.has(id)) id += '-' + (i + 1)
    seen.add(id)
    return id
  })
}
const dropAttrs = (open, names) => names.reduce((o, k) => o.replace(new RegExp('\\s' + k + '(?=[\\s=/>])(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+))?', 'i'), ''), open)
/* A photo slot with no photo: no src (nor srcset, nor a <picture> source), no alt. */
const emptyImage = (html, n) => [n, ...all(n)].filter((c) => c.tag === 'img' || c.tag === 'source').map((c) => {
  const open = dropAttrs(html.slice(c.start, c.openEnd), ['src', 'srcset', 'sizes'])
  return { start: c.start, end: c.openEnd, text: c.tag === 'img' ? setAttrs(open, { alt: '' }) : open }
})
/* A blank line: its own words cleared, any decorative children kept; blank paragraphs: emptied. */
const emptyText = (html, n, kind) => (kind !== 'textarea' && edit(html, n, 'text', '')) || { start: n.openEnd, end: n.closeStart, text: '' }

/* ---------- rewriting one element ---------------------------------------- */

/* Set attributes on the open tag at the start of `src`; existing ones are replaced, new ones appended. */
function setAttrs(src, attrs) {
  const openEnd = src.indexOf('>') + 1
  let open = src.slice(0, openEnd)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue
    const re = new RegExp('\\s' + k + '\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>/]+)', 'i')
    open = re.test(open) ? open.replace(re, () => ' ' + k + '="' + escAttr(v) + '"') : open.replace(/\s*\/?>$/, (t) => ' ' + k + '="' + escAttr(v) + '"' + t.trim())
  }
  return open + src.slice(openEnd)
}
/* One replacement for node `n` in `html` given a kind and value, or null when there is nothing to write. */
/* The first photo written into an element's inline background-image: the
   url() inside the existing declaration is replaced; with no declaration one
   is appended. The rest of the style attribute is untouched. */
function setBackground(src, url) {
  const open = src.slice(0, src.indexOf('>') + 1)
  const m = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(open)
  const style = m ? (m[2] ?? m[3] ?? '') : ''
  /* single quotes inside url(): the attribute itself is double-quoted and
     escAttr would turn inner double quotes into &quot; */
  const u = url.replace(/['"()\s]/g, encodeURIComponent)
  const next = BG_URL_RE.test(style) ? style.replace(BG_URL_RE, (_, a, q, _old, z) => a + "'" + u + "'" + z) : (style ? style.replace(/;?\s*$/, '; ') : '') + "background-image: url('" + u + "')"
  return setAttrs(src, { style: next })
}
function edit(html, n, kind, value, attr, subs) {
  if (value === undefined || value === null) return null
  if (kind === 'toggle') {
    /* shown when true: the `hidden` attribute goes; hidden when false: it is set */
    const open = outer(html, n).slice(0, n.openEnd - n.start)
    const on = value === true || value === 'true' || value === 1 || value === '1' || value === 'on'
    const has = /\shidden(?=[\s=/>])/i.test(open)
    if (on && !has) return null
    if (!on && has) return null
    const text = on ? dropAttrs(open, ['hidden']) : open.replace(/\s*\/?>$/, (t) => ' hidden' + t.trim())
    return { start: n.start, end: n.openEnd, text }
  }
  if (kind === 'embed') {
    const u = safeEmbedUrl(typeof value === 'object' && value ? value.src || value.url : value)
    if (!u) return null
    /* an iframe or video sets its own src; a <video> that uses <source> children sets the first one and drops the rest */
    if (n.tag === 'iframe' || n.attrs.src !== undefined || !n.children.some((c) => c.tag === 'source')) return { start: n.start, end: n.openEnd, text: setAttrs(outer(html, n).slice(0, n.openEnd - n.start), { src: u }) }
    const sources = n.children.filter((c) => c.tag === 'source')
    let out = '', pos = n.openEnd
    sources.forEach((s, i) => { out += html.slice(pos, s.start) + (i === 0 ? setAttrs(outer(html, s), { src: u }) : ''); pos = s.end })
    return { start: n.openEnd, end: n.closeStart, text: out + html.slice(pos, n.closeStart) }
  }
  if (kind === 'link') {
    const v = typeof value === 'string' ? { text: value } : isLinkValue(value) ? value : null
    if (!v) return null
    const a = n.tag === 'a' ? n : all(n).find((c) => c.tag === 'a')
    const edits = []
    if (a && typeof v.href === 'string' && v.href.trim()) { const u = safeLinkUrl(v.href); if (u) edits.push({ start: a.start, end: a.openEnd, text: setAttrs(outer(html, a).slice(0, a.openEnd - a.start), { href: u }) }) }
    if (typeof v.text === 'string' && v.text.trim() !== '') { const t = edit(html, n, 'text', v.text); if (t) edits.push(t) }
    if (!edits.length) return null
    /* one replacement covering the element: its open tag (href) and its words */
    return { start: n.start, end: n.end, text: splice(outer(html, n), edits.map((e) => ({ start: e.start - n.start, end: e.end - n.start, text: e.text }))) }
  }
  if (attr === 'content' || n.tag === 'meta') return typeof value === 'string' || typeof value === 'number' ? { start: n.start, end: n.end, text: setAttrs(outer(html, n), { content: String(value).replace(/\s+/g, ' ').trim() }) } : null
  if (attr === 'style' && kind === 'photos') { const ps = photoEntries(value); return ps.length ? { start: n.start, end: n.end, text: setBackground(outer(html, n), ps[0].url) } : null }
  if (attr === 'src' && kind === 'embed') return edit(html, n, 'embed', value)
  if (attr === 'src' || attr === 'href') { const m = media(value); const u = isLink(value) ? value.url : m && m.url; return u ? { start: n.start, end: n.end, text: setAttrs(outer(html, n), { [attr]: u }) } : null }
  if (kind === 'photos') {
    const ps = photoEntries(value)
    if (!ps.length) return null
    if (n.tag === 'img') return { start: n.start, end: n.end, text: setAttrs(outer(html, n), { src: ps[0].url, alt: ps[0].alt }) }
    const imgs = all(n).filter((c) => c.tag === 'img')
    /* no <img> in the slot but an inline background-image: the photo goes there */
    if (!imgs.length && BG_URL_RE.test(n.attrs.style || '')) return { start: n.start, end: n.end, text: setBackground(outer(html, n), ps[0].url) }
    if (!imgs.length) return null
    let out = '', pos = n.openEnd
    imgs.forEach((img, i) => { out += html.slice(pos, img.start) + (ps[i] ? setAttrs(outer(html, img), { src: ps[i].url, alt: ps[i].alt }) : ''); pos = img.end })
    const last = imgs[imgs.length - 1], gap = (html.slice(imgs.length > 1 ? imgs[imgs.length - 2].end : n.openEnd, last.start).match(/\s*$/) || [''])[0]
    for (let i = imgs.length; i < ps.length; i++) out += gap + setAttrs(outer(html, last), { src: ps[i].url, alt: ps[i].alt })
    return { start: n.openEnd, end: n.closeStart, text: out + html.slice(pos, n.closeStart) }
  }
  if (kind === 'file') { const u = isLink(value) ? value.url : (media(value) || {}).url; return u ? { start: n.start, end: n.end, text: setAttrs(outer(html, n), { href: u }) } : null }
  if (kind === 'list') {
    if (!Array.isArray(value)) return null
    const marked = all(n).filter((c) => 'data-tusk-item' in c.attrs && closest(c, (p) => 'data-tusk-list' in p.attrs || p === n) === n)
    const items = marked.length ? marked : subs && subs.item ? n.children.filter((c) => matches(c, compile(subs.item), undefined, n)) : n.children.filter((c) => c.tag !== 'script' && c.tag !== 'style')
    if (!items.length) return null
    const first = items[0], lead = html.slice(n.openEnd, first.start), gap = (html.slice(first.end, items[1] ? items[1].start : n.closeStart).match(/^\s*/) || [''])[0]
    /* An entry is built from the item the page already had for it, matched
       by id (the scanner's slug of the entry's first line, never position,
       so a reorder or a delete moves no one's photo onto someone else);
       an entry the page never had is built from the first item with every
       part emptied. Either way nothing of another entry's leaks in: an
       empty sub-field renders empty, except that a page item keeps its own
       photo until one is chosen. Same rule as tusk-preview.js setList and
       the SDK's setList — keep the three in step. */
    const specSubs = ((subs && subs.fields) || []).map((s) => (Array.isArray(s) ? { id: s[0], kind: s[2] } : s))
    /* the parts of one item: marked ones by data-tusk-field, bound ones by
       each sub-field's selector (scoped to the parsed copy, as before) */
    const partsOf = (doc, item) => {
      const out = []
      for (const p of all(item)) {
        if (!('data-tusk-field' in p.attrs) || closest(p, (q) => 'data-tusk-item' in q.attrs || q === item) !== item) continue
        const id = p.attrs['data-tusk-field'].replace(/[^A-Za-z0-9_]/g, '_'), spec = specSubs.find((s) => s.id === id)
        out.push({ node: p, id, kind: spec ? spec.kind : subKindOf(p) })
      }
      if (!marked.length) for (const s of specSubs) {
        if (!s.bind) continue
        const hit = select(doc, s.bind.selector).filter((p) => !('data-tusk-field' in p.attrs))
        if (hit.length === 1) out.push({ node: hit[0], id: s.id, kind: s.kind, attr: s.bind.attr === 'src' || s.bind.attr === 'href' ? s.bind.attr : undefined })
      }
      return out
    }
    const own = items.map((it) => { const src = outer(html, it), doc = parse(src); return { src, doc, item: doc.children[0] || doc } })
    const ids = itemIds(own.map((o) => partsOf(o.doc, o.item).map((p) => ({ id: p.id, kind: p.kind, text: ownText(o.src, p.node) }))), specSubs)
    const copies = value.map((entry) => {
      if (!entry || typeof entry !== 'object') return ''
      const at = ids.indexOf(String(entry.id))
      const mine = at >= 0, { src: proto, doc, item } = own[mine ? at : 0]
      const edits = []
      for (const part of partsOf(doc, item)) {
        const v = entry[part.id]
        if (part.kind === 'photo') {
          if (media(v) || isLink(v)) { const e = edit(proto, part.node, 'photos', part.attr ? v : [v], part.attr); if (e) edits.push(e) }
          else if (!mine) edits.push(...emptyImage(proto, part.node))
          continue
        }
        if (part.kind === 'link') {
          const lv = typeof v === 'string' ? { text: v } : isLinkValue(v) ? v : null
          if (lv && ((lv.text && String(lv.text).trim()) || (lv.href && String(lv.href).trim()))) { const e = edit(proto, part.node, 'link', lv); if (e) edits.push(e) }
          else edits.push(emptyText(proto, part.node, 'text'))
          continue
        }
        if (v === undefined || v === null || v === '') { edits.push(emptyText(proto, part.node, part.kind)); continue }
        const e = edit(proto, part.node, part.kind === 'textarea' ? 'textarea' : 'text', v, part.attr)
        if (e) edits.push(e)
      }
      return splice(proto, edits)
    }).filter(Boolean)
    return { start: n.openEnd, end: n.closeStart, text: lead + copies.join(gap) + html.slice(items[items.length - 1].end, n.closeStart) }
  }
  if (kind === 'html') {
    /* the opt-in rich kind: the client's markup, reduced to safe inline tags,
       replaces the element's inner content. Untrusted on the way in. */
    if (typeof value !== 'string') return null
    return { start: n.openEnd, end: n.closeStart, text: sanitizeInlineHtml(value) }
  }
  if (kind === 'textarea') {
    const paras = String(value).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
    if (!paras.length) return null
    if (/^(p|h[1-6]|li|dd|td|span|a|blockquote)$/.test(n.tag) || !n.children.some((c) => c.tag === 'p')) {
      if (paras.length === 1 || n.tag !== 'p') return { start: n.openEnd, end: n.closeStart, text: paras.map(esc).join('<br>\n<br>\n') }
      const open = html.slice(n.start, n.openEnd), gap = '\n' + (html.slice(0, n.start).match(/[ \t]*$/) || [''])[0]
      return { start: n.start, end: n.end, text: paras.map((p) => open + esc(p) + '</p>').join(gap) }
    }
    const ind = (inner(html, n).match(/^\s*/) || [''])[0], tail = (inner(html, n).match(/\s*$/) || [''])[0]
    return { start: n.openEnd, end: n.closeStart, text: ind + paras.map((p) => '<p>' + esc(p) + '</p>').join(ind || '\n') + tail }
  }
  /* a plain-text element: every line of the value goes back into the text
     slot it came from (see textSlots), so a <br>, a styled <span> or a
     leading icon survives the publish exactly as the developer wrote it */
  return typeof value === 'string' || typeof value === 'number' ? setTextEdit(html, n, value) : null
}

/* ---------- the words of a plain-text element: text slots ---------------
   The SAME rule as scan.ts fullText and tusk-preview.js textSlots: the
   element's own text runs and, recursively, those of its inline children, in
   reading order, grouped into lines at a <br> and at the edge of a block
   child; icons, scripts and nested marks are skipped. A slot here is a range
   of the source html, so a write replaces exactly those bytes and nothing
   else. Keep the three in step. */
const BLOCK_TAGS = new Set(['div', 'p', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'table', 'tr', 'td', 'th', 'figcaption', 'figure', 'dd', 'dt', 'nav', 'aside', 'main', 'form'])
const SKIP_TAGS = new Set(['script', 'style', 'svg', 'img', 'picture', 'video', 'iframe', 'noscript', 'template'])
const isOwnField = (c) => 'data-tusk' in c.attrs || 'data-tusk-list' in c.attrs || 'data-tusk-item' in c.attrs
const hasWords = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() !== ''
function textSlots(html, n) {
  const groups = [[]]
  const newLine = () => { if (groups[groups.length - 1].length) groups.push([]) }
  const walk = (node) => {
    let pos = node.openEnd
    for (const c of node.children) {
      if (hasWords(html.slice(pos, c.start))) groups[groups.length - 1].push({ start: pos, end: c.start })
      pos = c.end
      if (c.tag === 'br') { newLine(); continue }
      if (SKIP_TAGS.has(c.tag) || isOwnField(c)) continue
      const block = BLOCK_TAGS.has(c.tag)
      if (block) newLine()
      walk(c)
      if (block) newLine()
    }
    if (hasWords(html.slice(pos, node.closeStart))) groups[groups.length - 1].push({ start: pos, end: node.closeStart })
  }
  walk(n)
  return groups.filter((g) => g.length)
}
const splitLines = (value) => {
  const lines = String(value).split('\n').map((s) => s.replace(/\s+/g, ' ').trim())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines
}
function setTextEdit(html, n, value) {
  const lines = splitLines(value), groups = textSlots(html, n)
  if (groups.length && groups.length === lines.length) {
    /* each line back into its own slot, the rest of the markup byte for byte */
    const reps = []
    groups.forEach((g, i) => g.forEach((s, j) => reps.push({ start: s.start, end: s.end, text: j === 0 ? esc(lines[i]) : '' })))
    reps.sort((a, b) => a.start - b.start)
    let out = '', pos = n.openEnd
    for (const r of reps) { out += html.slice(pos, r.start) + r.text; pos = r.end }
    return { start: n.openEnd, end: n.closeStart, text: out + html.slice(pos, n.closeStart) }
  }
  /* nothing editable yet (an icon only): the words go in front of it */
  if (!groups.length && n.children.length) return { start: n.openEnd, end: n.children[0].start, text: lines.map(esc).join('<br>') + html.slice(n.openEnd, n.children[0].start) }
  /* a line was added or removed, so the old markup no longer fits: plain lines */
  return { start: n.openEnd, end: n.closeStart, text: lines.map(esc).join('<br>') }
}

/* Apply non-overlapping replacements, outermost first when they nest. */
function splice(html, edits) {
  const kept = []
  for (const e of edits.sort((a, b) => a.start - b.start || b.end - a.end)) if (!kept.some((k) => e.start < k.end && e.end > k.start)) kept.push(e)
  let out = html
  for (const e of kept.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

/* ---------- pages ---------------------------------------------------------- */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
function pageKeyFor(rel, root) {
  const body = all(root).find((n) => n.tag === 'body')
  const named = body && body.attrs['data-tusk-page']
  if (named) return slug(named) || 'home'
  const p = rel.replace(/\\/g, '/').replace(/\.html?$/i, '').replace(/(^|\/)index$/, '')
  return slug(p.split('/').filter(Boolean).join('-')) || 'home'
}

function applyPage(html, pageKey) {
  const root = parse(html), edits = []
  for (const n of all(root)) {
    const ref = n.attrs['data-tusk'] ?? n.attrs['data-tusk-list']
    if (ref === undefined || closest(n, (p) => 'data-tusk-list' in p.attrs)) continue
    const value = fieldValue(pageKey, ref)
    const kind = 'data-tusk-list' in n.attrs ? 'list' : kindOf(n, value, (n.attrs['data-tusk-kind'] || '').toLowerCase())
    const e = edit(html, n, kind, value)
    if (e) edits.push(e)
  }
  const specs = ((snap.schema || {}).pages || {})[pageKey]
  for (const f of (specs && specs.fields) || []) {
    if (!f.bind || !f.bind.selector) continue
    const hit = select(root, f.bind.selector).filter((n) => !('data-tusk' in n.attrs) && !('data-tusk-list' in n.attrs))
    if (hit.length !== 1) continue
    /* `html` is not on this list — neither as bind.attr nor as the field's
       kind. A bind is derived from a selector, not an explicit opt-in in the
       page, so it may never write markup from a client's stored content into
       the built website. Only a data-tusk-kind="html" mark (handled above)
       round-trips markup; a bound field's kind html is treated as text. */
    const attr = ['src', 'href', 'content', 'style'].includes(f.bind.attr) ? f.bind.attr : undefined
    const boundKind = f.kind === 'files' ? 'file' : f.kind === 'html' ? 'text' : f.kind
    const e = edit(html, hit[0], boundKind, fieldValue(pageKey, f.id), attr, f.kind === 'list' ? { item: f.bind.item, fields: (f.fields || []).map((s) => (Array.isArray(s) ? { id: s[0], kind: s[2] } : s)) } : undefined)
    if (e) edits.push(e)
  }
  return { html: splice(html, edits), count: edits.length }
}

/* ---------- the Free-plan badge ------------------------------------------
   One fixed pill, bottom right, in Tusk's colours, written as plain markup
   with inline styles. It is identified by data-tusk-badge so a later build
   can find and replace or remove it. Only an http(s) href is ever written. */
const BADGE_RE = /[ \t]*<a\b[^>]*\bdata-tusk-badge\b[^>]*>[\s\S]*?<\/a>[ \t]*\r?\n?/gi
const badgeMarkup = (b) =>
  '<a data-tusk-badge href="' + escAttr(b.href) + '" target="_blank" rel="noopener" title="This site is edited by its owner with Tusk"' +
  ' style="position:fixed;right:14px;bottom:14px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border-radius:999px;background:#182825;color:#F4F2E9;font:600 12px/1 Arial,Helvetica,sans-serif;text-decoration:none;letter-spacing:.01em;box-shadow:0 2px 10px rgba(24,40,37,.25)">' +
  '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#CDF477"></span>' + esc(b.text || 'Edited with Tusk') + '</a>'
const hasBadge = () => !!(snap && snap.badge && typeof snap.badge.href === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(snap.badge.href))
function withBadge(html) {
  const bare = html.replace(BADGE_RE, '')
  if (!hasBadge()) return bare
  const i = bare.search(/<\/body\s*>/i)
  const tag = badgeMarkup(snap.badge) + '\n'
  return i < 0 ? bare + '\n' + tag : bare.slice(0, i) + tag + bare.slice(i)
}

async function walk(d, out = []) { for (const e of await readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(p, out) } else if (/\.html?$/i.test(e.name)) out.push(p) } return out }

async function main() {
  if (!dir) fail('usage: node tusk-apply.mjs <folder of built html> [published.json]')
  try { snap = JSON.parse(await readFile(snapFile, 'utf8')) } catch { fail('no snapshot at ' + snapFile + '. Run tusk-pull.mjs first.') }
  try { if (!(await stat(dir)).isDirectory()) throw 0 } catch { fail(dir + ' is not a folder.') }
  let files = 0, written = 0, fields = 0
  for (const file of await walk(path.resolve(dir))) {
    const html = await readFile(file, 'utf8'), rel = path.relative(path.resolve(dir), file)
    const key = pageKeyFor(rel, parse(html))
    if (!snap.pages || !snap.pages[key]) continue
    files++
    const r = applyPage(html, key)
    fields += r.count
    const out = withBadge(r.html)
    if (out !== html) { await writeFile(file, out); written++ }
    console.log('tusk: ' + rel.replace(/\\/g, '/') + ' <- ' + key + ' · ' + r.count + ' field' + (r.count === 1 ? '' : 's') + (hasBadge() ? ' · badge' : '') + (out === html ? ' (unchanged)' : ''))
  }
  console.log('tusk: ' + files + ' page' + (files === 1 ? '' : 's') + ' matched, ' + written + ' rewritten, ' + fields + ' fields written from ' + (path.relative(process.cwd(), snapFile) || snapFile) + (hasBadge() ? ' · "' + (snap.badge.text || 'Edited with Tusk') + '" badge on (Free plan; a paid plan removes it on the next build)' : ''))
}

main().catch((e) => { console.error('tusk: ' + e.message); process.exitCode = 1 })
