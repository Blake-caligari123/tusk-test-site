#!/usr/bin/env node
/* ==========================================================================
   tusk-pull.mjs: bring a site's published content into its build.

   One file, plain Node 18 or newer, no packages. Download it into the site's
   repository (curl -O https://tuskcms.com/sdk/tusk-pull.mjs) and run it
   before the build:

     TUSK_SITE=north-studio TUSK_TOKEN=<build token> node tusk-pull.mjs

   or as "prebuild" in package.json with those variables set on the host.

   It reads
     TUSK_SITE    the site's slug, as shown in the Tusk dashboard
     TUSK_TOKEN   the site's build token (Manage > Setup > Advanced >
                  Build token). Never printed, never written to disk.
     TUSK_URL     where Tusk runs; default https://tuskcms.com
   and
     GETs  <TUSK_URL>/api/published/<site>/snapshot?assets=1
     downloads every photo and upload to public/tusk/<filename>
           (a file already there with the same size is left alone;
            set TUSK_FORCE=1 to re-download everything)
     rewrites the snapshot's media URLs to /tusk/<filename>
     writes .tusk/published.json

   Options, as variables: TUSK_OUT (default .tusk), TUSK_ASSETS (default
   public/tusk), TUSK_PUBLIC (the URL path the site serves TUSK_ASSETS at,
   default /tusk).

   Prints one summary line. Exits 1 with a plain reason when the site, the
   token or the network is wrong. The same logic as `tusk pull` in
   @tuskcms/sdk, for people who cannot install packages.
   ========================================================================== */

import { mkdir, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const env = process.env
const site = (env.TUSK_SITE || '').trim()
const token = (env.TUSK_TOKEN || '').trim()
const base = (env.TUSK_URL || 'https://tuskcms.com').trim().replace(/\/+$/, '')
const outDir = path.resolve(env.TUSK_OUT || '.tusk')
const assetsDir = path.resolve(env.TUSK_ASSETS || 'public/tusk')
const publicPath = (env.TUSK_PUBLIC || '/tusk').replace(/\/+$/, '')
const force = env.TUSK_FORCE === '1'

/* Errors are thrown and reported once at the bottom; no process.exit, so an
   open connection can close cleanly and the exit code is still 1. */
const fail = (msg) => { throw new Error(msg) }

async function main() {
  if (!site) fail('TUSK_SITE is not set. It is the site\'s slug, as shown in the Tusk dashboard.')
  if (!token) fail('TUSK_TOKEN is not set. The build token is under Manage > Setup > Advanced > Build token in Tusk.')
  if (typeof fetch !== 'function') fail('this script needs Node 18 or newer (fetch is missing). You have ' + process.version + '.')

  /* The name at the end of a URL, without query or hash. */
  const basenameOf = (u) => {
    if (!u) return ''
    try { return decodeURIComponent(u.split('?')[0].split('#')[0].split('/').pop() || '') } catch { return '' }
  }
  /* A filename from the server is written under assetsDir and nowhere else. */
  const safeName = (name) => path.basename(name).replace(/[\x00-\x1f<>:"|?*\\/]/g, '_')

  async function fetchJSON(url) {
    let r
    try {
      r = await fetch(url, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' } })
    } catch (e) {
      fail('could not reach Tusk at ' + url + ': ' + e.message)
    }
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    if (!r.ok) {
      const msg = body && body.error
      if (r.status === 401) fail('Tusk refused the request (401): ' + (msg || 'a build token is required.') + ' Check TUSK_TOKEN.')
      if (r.status === 404) fail('Tusk answered 404 for that site: the slug or the build token is wrong. Check TUSK_SITE and TUSK_TOKEN.')
      fail('Tusk answered ' + r.status + (msg ? ': ' + msg : '') + '.')
    }
    if (!body || typeof body !== 'object') fail('Tusk answered with something that is not JSON from ' + url + '.')
    return body
  }

  async function sameSize(file, size) {
    if (!size) return false
    try { return (await stat(file)).size === size } catch { return false }
  }

  const feed = await fetchJSON(base + '/api/published/' + encodeURIComponent(site) + '/snapshot?assets=1')
  const { assets = [], stored, store, ...snapshot } = feed
  void store
  if (!snapshot.pages) fail('the snapshot has no pages. Has the site been published?')

  await mkdir(outDir, { recursive: true })
  /* Always, not only when there is something to download: build.json is
     written here on every run, and a site with no uploads has no folder yet. */
  await mkdir(assetsDir, { recursive: true })

  /* Every asset by filename, so a media entry's four URLs can be rewritten
     by the name at the end of each. */
  const written = new Map()
  const failed = []
  let downloaded = 0, skipped = 0
  for (const a of assets) {
    const name = safeName(a.filename || '')
    if (!name) continue
    const dest = path.join(assetsDir, name)
    if (!force && (await sameSize(dest, a.size))) { skipped++; written.set(a.filename, name); continue }
    try {
      const r = await fetch(a.url, { headers: { authorization: 'Bearer ' + token } })
      if (!r.ok) throw new Error(String(r.status))
      await writeFile(dest, new Uint8Array(await r.arrayBuffer()))
      written.set(a.filename, name)
      downloaded++
    } catch (e) {
      failed.push(a.filename + ' (' + e.message + ')')
    }
  }

  /* Rewrite: every media URL that points at a file we now hold becomes a
     path the built site serves. Anything we could not fetch keeps its URL. */
  let rewritten = 0
  for (const m of Object.values(snapshot.media || {})) {
    for (const key of ['url', 'thumb', 'card', 'hero']) {
      const u = m[key]
      if (!u) continue
      const name = written.get(basenameOf(u))
      if (name) { m[key] = publicPath + '/' + encodeURIComponent(name); rewritten++ }
    }
  }

  const out = { ...snapshot, pulled: { at: new Date().toISOString(), from: base, assets: written.size, publicPath } }
  const file = path.join(outDir, 'published.json')
  await writeFile(file, JSON.stringify(out, null, 2))
  /* Served at <publicPath>/build.json: Tusk reads it to confirm the site is serving this publish. */
  await writeFile(path.join(assetsDir, 'build.json'), JSON.stringify({ site: snapshot.site && snapshot.site.slug, publishedAt: snapshot.publishedAt || null, snapshotAt: snapshot.snapshotAt || null, builtAt: out.pulled.at }))

  const pages = Object.keys(snapshot.pages).length, media = Object.keys(snapshot.media || {}).length
  console.log('tusk: ' + ((snapshot.site && snapshot.site.name) || site) + ' · ' + pages + ' page' + (pages === 1 ? '' : 's') + ' · ' + media + ' media · ' +
    downloaded + ' downloaded, ' + skipped + ' already there, ' + rewritten + ' URLs rewritten -> ' + (path.relative(process.cwd(), file) || file) +
    (stored === false ? ' (live view; publish once to store a snapshot)' : ''))
  for (const f of failed) console.error('tusk: could not fetch ' + f)
}

main().catch((e) => { console.error('tusk: ' + e.message); process.exitCode = 1 })
