// Conformance tests against boxes produced by other implementations.
// See fixtures/README.md for provenance and how to regenerate (rarely!).

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as Y from 'yjs'
import { checkMoved, openVfs } from '../src/index'

const fixtureUrl = (name: string) => new URL(`../fixtures/${name}`, import.meta.url)

function loadB64(name: string): { doc: Y.Doc; bytes: Uint8Array } {
  const b64 = readFileSync(fixtureUrl(name), 'utf8').trim()
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bytes)
  return { doc, bytes }
}

const readJson = (name: string) => JSON.parse(readFileSync(fixtureUrl(name), 'utf8'))

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const hex = (bytes: Uint8Array | null) => (bytes ? Buffer.from(bytes).toString('hex') : null)

interface Entry {
  str: string | null
  bytesHex: string | null
  isBinary: boolean
}

describe('legacy clean box (written via yjs-datatools)', () => {
  it('matches the legacy reader exactly', () => {
    const report = readJson('legacy-clean.report.json')
    const { doc, bytes } = loadB64('legacy-clean.b64')
    expect(sha256(bytes)).toBe(report.updateSha256)

    const vfs = openVfs(doc, 'BOX')!
    expect(vfs).toBeTruthy()
    expect(vfs.isEmpty()).toBe(report.isEmpty)
    expect(vfs.listFiles()).toEqual(report.files)

    for (const [file, entry] of Object.entries<Entry>(report.entries)) {
      expect(vfs.isBinary(file)).toBe(entry.isBinary)
      // For binary nodes the legacy reader returned the raw base64 string,
      // while yjs-boxtools decodes to text (lossy by design). Bytes are the
      // authoritative comparison; string equality only for text nodes.
      if (!entry.isBinary) expect(vfs.readFileAsString(file)).toBe(entry.str)
      expect(hex(vfs.readFileAsBytes(file))).toBe(entry.bytesHex)
    }
  })

  it('returns live Y.Text objects', () => {
    const { doc } = loadB64('legacy-clean.b64')
    const vfs = openVfs(doc, 'BOX')!
    const text = vfs.getFile('notes.txt')!
    expect(text.toString()).toBe('note\n')
    text.insert(0, '> ')
    expect(vfs.readFileAsString('notes.txt')).toBe('> note\n')
  })

  it('accepts writes on top of a legacy box', () => {
    const { doc } = loadB64('legacy-clean.b64')
    const vfs = openVfs(doc, 'BOX')!
    vfs.ensureFile('dir/inner/new.typ')
    vfs.setFile('dir/inner/new.typ', '= New\n')
    expect(vfs.readFileAsString('dir/inner/new.typ')).toBe('= New\n')
    vfs.renameNode('dir/inner/new.typ', 'dir/renamed.typ')
    expect(vfs.listFiles()).toContain('dir/renamed.typ')
    vfs.deleteNode('dir/renamed.typ')
    expect(vfs.listFiles()).not.toContain('dir/renamed.typ')
    expect(vfs.listFiles()).toEqual(
      expect.arrayContaining(['dir/', 'dir/inner/', 'dir/moved.typ', 'img/pixel.png', 'notes.txt']),
    )
  })
})

describe('legacy dirty box (stale keys, tombstones, unknown types)', () => {
  it('lists only live entries', () => {
    const report = readJson('legacy-dirty.report.json')
    const { doc } = loadB64('legacy-dirty.b64')
    const vfs = openVfs(doc, 'BOX')!
    expect(vfs.listFiles()).toEqual(report.files)
  })

  it('reads the moved marker', () => {
    const report = readJson('legacy-dirty.report.json')
    const { doc } = loadB64('legacy-dirty.b64')
    expect(checkMoved(doc)).toEqual(report.moved)
  })

  it('sweeps stale keys, reclaims nodes, leaves unreachable orphans', () => {
    const report = readJson('legacy-dirty.report.json')
    const { doc } = loadB64('legacy-dirty.b64')
    const vfs = openVfs(doc, 'BOX')!
    const box = doc.getMap().get('BOX') as Y.Map<unknown>

    expect(vfs.sweepStaleKeys()).toBe(report.dropped)
    for (const id of report.reclaimedIds) expect(box.has(id)).toBe(false)
    // Legacy deleteNode unlinked the key, so the tombstoned map is
    // unreachable by design; the sweep must not resurrect/GC it.
    expect(box.has(report.orphanId)).toBe(true)

    expect(vfs.sweepStaleKeys()).toBe(0)
    expect(vfs.listFiles()).toEqual(report.files)
  })
})

describe('roundtrip (yjs-boxtools writes, yjs-datatools read)', () => {
  it('produces the tree the legacy reader recorded', () => {
    const report = readJson('roundtrip.report.json')
    const doc = new Y.Doc()
    const vfs = openVfs(doc, 'BOX', true)!

    vfs.setFile('readme.md', '# roundtrip\nhello\n')
    vfs.mkdir('dir/inner')
    vfs.setFile('dir/inner/deep.typ', '= Deep\n')
    vfs.renameNode('dir/inner/deep.typ', 'dir/moved.typ')
    vfs.setFile(
      'img/pixel.png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    )
    vfs.deleteNode('readme.md')

    expect(vfs.isEmpty()).toBe(report.isEmpty)
    expect(vfs.listFiles()).toEqual(report.files)
    for (const [file, entry] of Object.entries<Entry>(report.entries)) {
      expect(vfs.isBinary(file)).toBe(entry.isBinary)
      // For binary nodes the legacy reader returned the raw base64 string,
      // while yjs-boxtools decodes to text (lossy by design). Bytes are the
      // authoritative comparison; string equality only for text nodes.
      if (!entry.isBinary) expect(vfs.readFileAsString(file)).toBe(entry.str)
      expect(hex(vfs.readFileAsBytes(file))).toBe(entry.bytesHex)
    }
  })
})
