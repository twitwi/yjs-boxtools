import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  checkMoved, getFileText, inBoxPath, joinBoxPath, listBoxFiles, openBox, openMap, openVfs,
  parseConfig, parseHash, pathOfId, splitBoxPath, stripInBoxSuffix, watchBox, watchFile,
} from '../src/index'
import { newDocWithFile } from './helpers'

describe('splitBoxPath', () => {
  it('splits at the first /@/', () => {
    expect(splitBoxPath('BOX/@/shop.yaml')).toEqual({ boxPath: 'BOX', innerPath: 'shop.yaml' })
    expect(splitBoxPath('BOX/@/lists/old.yaml')).toEqual({ boxPath: 'BOX', innerPath: 'lists/old.yaml' })
  })
  it('tolerates @ and spaces in names', () => {
    expect(splitBoxPath('my box/@/a@b.yaml')).toEqual({ boxPath: 'my box', innerPath: 'a@b.yaml' })
  })
  it('rejects paths without a usable /@/', () => {
    expect(() => splitBoxPath('BOX/shop.yaml')).toThrow()
    expect(() => splitBoxPath('BOX/@')).toThrow()
    expect(() => splitBoxPath('')).toThrow()
  })
  it('joinBoxPath round-trips', () => {
    expect(joinBoxPath('BOX', 'shop.yaml')).toBe('BOX/@/shop.yaml')
  })
})

describe('stripInBoxSuffix / inBoxPath', () => {
  it('strips a trailing /@/ suffix from a config path', () => {
    expect(stripInBoxSuffix('BOX/@/lists/old.yaml')).toBe('BOX')
    expect(stripInBoxSuffix('BOX/@/shop.yaml')).toBe('BOX')
  })
  it('leaves a bare box path unchanged', () => {
    expect(stripInBoxSuffix('BOX')).toBe('BOX')
    expect(stripInBoxSuffix('sub/folder')).toBe('sub/folder')
  })
  it('builds a full in-box path from a bare config path', () => {
    expect(inBoxPath('BOX', 'shop.yaml')).toBe('BOX/@/shop.yaml')
    expect(inBoxPath('sub/folder', 'lists/old.yaml')).toBe('sub/folder/@/lists/old.yaml')
  })
  it('builds a full in-box path from a config path that already has /@/', () => {
    expect(inBoxPath('BOX/@/lists', 'shop.yaml')).toBe('BOX/@/shop.yaml')
  })
})

describe('parseConfig', () => {
  it('parses 3- and 4-part configs', () => {
    expect(parseConfig('s::d::t', 'BOX/@/shop.yaml')).toEqual({
      server: 's',
      docname: 'd',
      token: 't',
      boxPath: 'BOX/@/shop.yaml',
    })
    expect(parseConfig('s::d::t::B/@/f.yaml', 'BOX/@/shop.yaml').boxPath).toBe('B/@/f.yaml')
  })
  it('rejects malformed configs', () => {
    expect(() => parseConfig('s::d', 'BOX/@/shop.yaml')).toThrow()
    expect(() => parseConfig('a::b::c::d::e', 'BOX/@/shop.yaml')).toThrow()
  })
  it('rejects empty server/docname, trims whitespace', () => {
    expect(() => parseConfig('::::tok', 'BOX/@/shop.yaml')).toThrow()
    expect(() => parseConfig('s::  ::tok', 'BOX/@/shop.yaml')).toThrow()
    // empty token is fine (some servers need none)
    expect(parseConfig('s::d::', 'BOX/@/shop.yaml').token).toBe('')
    expect(parseConfig('  s  ::d::t', 'BOX/@/shop.yaml').server).toBe('s')
  })
})

describe('box filesystem', () => {
  it('getFileText returns undefined without create (never creates)', () => {
    const doc = new Y.Doc()
    expect(getFileText(doc, 'BOX/@/shop.yaml')).toBeUndefined()
    // still nothing: no box map materialized
    expect(openMap(doc, 'BOX', false)).toBeUndefined()
  })

  it('getFileText with create makes parents + empty file, keeps content', () => {
    const doc = new Y.Doc()
    const t = getFileText(doc, 'BOX/@/lists/shop.yaml', true)
    expect(t).toBeInstanceOf(Y.Text)
    expect(t?.toString()).toBe('')
    // second create call returns the same live text, content untouched
    t?.insert(0, 'hello')
    expect(getFileText(doc, 'BOX/@/lists/shop.yaml', true)?.toString()).toBe('hello')
  })

  it('listBoxFiles walks nested dirs, sorted', () => {
    const doc = newDocWithFile('BOX/@/b.yaml', 'B')
    const vfs = openBox(doc, 'BOX/@/b.yaml')!
    vfs.setFile('a.yaml', 'A')
    vfs.setFile('lists/old.yaml', 'O')
    expect(listBoxFiles(doc, 'BOX/@/b.yaml')).toEqual(['a.yaml', 'b.yaml', 'lists/old.yaml'])
  })

  it('setFile replaces, readFileAsString reads, deleteNode unlinks', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f.yaml', true)!
    vfs.setFile('f.yaml', 'one')
    vfs.setFile('f.yaml', 'two')
    expect(vfs.readFileAsString('f.yaml')).toBe('two')
    vfs.deleteNode('f.yaml')
    expect(vfs.getFile('f.yaml')).toBeUndefined()
    expect(vfs.isEmpty()).toBe(true)
  })

  it('rename moves within the box, creating target parents', () => {
    const doc = newDocWithFile('BOX/@/old.yaml', 'x')
    const vfs = openBox(doc, 'BOX/@/old.yaml')!
    vfs.renameNode('old.yaml', 'archive/old.yaml')
    expect(vfs.readFileAsString('archive/old.yaml')).toBe('x')
    expect(vfs.getFile('old.yaml')).toBeUndefined()
  })

  it('mkdir is idempotent and a file in the way throws', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    vfs.mkdir('a/b')
    vfs.mkdir('a/b')
    vfs.setFile('a/f.yaml', 'x')
    expect(() => vfs.mkdir('a/f.yaml/c')).toThrow()
  })

  it('live text stays live across handles (same Y.Text identity)', () => {
    const doc = newDocWithFile('BOX/@/s.yaml', 'abc')
    const a = getFileText(doc, 'BOX/@/s.yaml')
    const b = openBox(doc, 'BOX/@/s.yaml')?.getFile('s.yaml')
    expect(a).toBe(b)
  })

  it('openVfs resolves plain map paths (no /@/)', () => {
    const doc = new Y.Doc()
    expect(openVfs(doc, 'proj', false)).toBeUndefined()
    const vfs = openVfs(doc, 'proj', true)!
    vfs.setFile('main.typ', 'hi')
    expect(openVfs(doc, 'proj', false)?.readFileAsString('main.typ')).toBe('hi')
  })

  it('description is exposed for observeDeep versioning', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    let hits = 0
    vfs.description.observeDeep(() => hits++)
    vfs.setFile('f.yaml', 'x')
    expect(hits).toBeGreaterThan(0)
  })

  it('binary round-trips bytes via base64', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    vfs.setFile('img.bin', bytes)
    expect(vfs.isBinary('img.bin')).toBe(true)
    expect(vfs.readFileAsBytes('img.bin')).toEqual(bytes)
    expect(vfs.readFileAsString('img.bin')).not.toBeNull()
    // binaries count as files in listings
    expect(listBoxFiles(doc, 'BOX/@/f')).toContain('img.bin')
    // text files are not binary and read back as bytes too
    vfs.setFile('t.txt', 'abc')
    expect(vfs.isBinary('t.txt')).toBe(false)
    expect(vfs.readFileAsBytes('t.txt')).toEqual(new TextEncoder().encode('abc'))
  })

  it('replacing text with bytes flips the node to binary', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    vfs.setFile('f', 'plain')
    expect(vfs.isBinary('f')).toBe(false)
    const bytes = new Uint8Array([1, 2, 3])
    vfs.setFile('f', bytes)
    expect(vfs.isBinary('f')).toBe(true)
    expect(vfs.readFileAsBytes('f')).toEqual(bytes)
  })

  it('missing binary reads are silent', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    expect(vfs.isBinary('nope')).toBe(false)
    expect(vfs.readFileAsBytes('nope')).toBeNull()
  })
})

describe('renameNode parent tracking', () => {
  it('cross-directory rename keeps id->path resolution working', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    vfs.setFile('a/f.yaml', 'x')
    const id = (vfs.description.get('root:') as Y.Map<unknown>).get('children')
    void id
    // find the file's node id via the children map
    const root = vfs.description.get('root:') as Y.Map<unknown>
    const aId = (root.get('children') as Y.Map<string>).get('a')!
    const aNode = vfs.description.get(aId) as Y.Map<unknown>
    const fId = (aNode.get('children') as Y.Map<string>).get('f.yaml')!
    expect(pathOfId(vfs.description, fId)).toBe('a/f.yaml')
    vfs.renameNode('a/f.yaml', 'b/f.yaml')
    expect(pathOfId(vfs.description, fId)).toBe('b/f.yaml')
    expect(vfs.readFileAsString('b/f.yaml')).toBe('x')
  })
})

describe('watchBox', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports created/changed/deleted with paths, batched per flush', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    const seen: { type: string; path: string | null }[][] = []
    const unwatch = watchBox(vfs.description, (evs) => seen.push(evs))
    vfs.setFile('a.yaml', 'A')
    vfs.setFile('b.yaml', 'B')
    expect(seen.length).toBe(0) // nothing before the 5ms flush
    vi.advanceTimersByTime(5)
    expect(seen.length).toBe(1)
    const flat = seen[0]
    expect(flat).toContainEqual({ type: 'created', path: 'a.yaml' })
    expect(flat).toContainEqual({ type: 'created', path: 'b.yaml' })
    vfs.setFile('a.yaml', 'A2')
    vi.advanceTimersByTime(5)
    expect(seen[1]).toContainEqual({ type: 'changed', path: 'a.yaml' })
    vfs.deleteNode('b.yaml')
    vi.advanceTimersByTime(5)
    expect(seen[2]).toContainEqual({ type: 'deleted', path: 'b.yaml' })
    unwatch()
    vfs.setFile('c.yaml', 'C')
    vi.advanceTimersByTime(5)
    expect(seen.length).toBe(3) // silent after unwatch
  })
})

describe('watchFile', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks content, silence on identical, null while absent', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    vfs.setFile('f.yaml', 'one')
    const got: (string | null)[] = []
    const unwatch = watchFile(vfs, 'f.yaml', (c) => got.push(c))
    vfs.setFile('f.yaml', 'one') // identical rewrite: silent
    vi.advanceTimersByTime(5)
    expect(got).toEqual([])
    vfs.setFile('f.yaml', 'two')
    vi.advanceTimersByTime(5)
    expect(got).toEqual(['two'])
    vfs.deleteNode('f.yaml')
    vi.advanceTimersByTime(5)
    expect(got).toEqual(['two', null])
    vfs.setFile('f.yaml', 'three') // recreate re-binds
    vi.advanceTimersByTime(5)
    expect(got).toEqual(['two', null, 'three'])
    unwatch()
  })
})

describe('sweepStaleKeys', () => {
  // Build the mess current codyjs leaves behind: tombstone node + stale
  // children key, a key pointing at a missing id, an unknown-type node.
  function codyjsShapedBox(): { doc: Y.Doc; vfs: ReturnType<typeof openBox> & {} } {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    vfs.setFile('live.txt', 'keep me')
    vfs.setFile('dead.txt', 'gone')
    const box = vfs.description
    const root = box.get('root:') as Y.Map<unknown>
    const children = root.get('children') as Y.Map<string>
    // tombstone in place (children key NOT unlinked, like unfixed codyjs)
    const deadId = children.get('dead.txt')!
    ;(box.get(deadId) as Y.Map<unknown>).set('type', 'deleted')
    // dangling id
    children.set('ghost.txt', 'id:missing')
    // unknown-type node
    const weird = new Y.Map<unknown>()
    weird.set('type', 'symlink')
    box.set('id:weird', weird)
    children.set('weird.txt', 'id:weird')
    return { doc, vfs }
  }

  it('drops exactly the stale entries, keeps live files', () => {
    const { vfs } = codyjsShapedBox()
    expect(vfs.sweepStaleKeys()).toBe(3)
    expect(vfs.listFiles()).toEqual(['live.txt'])
    expect(vfs.readFileAsString('live.txt')).toBe('keep me')
  })

  it('is idempotent and reclaims node maps', () => {
    const { vfs } = codyjsShapedBox()
    const before = [...vfs.description.keys()].length
    vfs.sweepStaleKeys()
    const after = [...vfs.description.keys()].length
    expect(after).toBeLessThan(before)
    expect(vfs.sweepStaleKeys()).toBe(0)
  })

  it('rename onto a swept name succeeds (interop fix)', () => {
    const { vfs } = codyjsShapedBox()
    vfs.sweepStaleKeys()
    vfs.renameNode('live.txt', 'dead.txt')
    expect(vfs.readFileAsString('dead.txt')).toBe('keep me')
  })

  it('leaves shared live nodes alone', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    vfs.setFile('a.txt', 'x')
    const box = vfs.description
    const root = box.get('root:') as Y.Map<unknown>
    const children = root.get('children') as Y.Map<string>
    const id = children.get('a.txt')!
    children.set('b.txt', id) // same node under two names (pathological but legal)
    expect(vfs.sweepStaleKeys()).toBe(0)
    expect(vfs.readFileAsString('a.txt')).toBe('x')
    expect(vfs.readFileAsString('b.txt')).toBe('x')
  })

  it('reclaims a tombstoned directory subtree', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    vfs.setFile('sub/a.txt', 'x')
    vfs.setFile('sub/b.txt', 'y')
    const box = vfs.description
    const root = box.get('root:') as Y.Map<unknown>
    const children = root.get('children') as Y.Map<string>
    const subId = children.get('sub')!
    ;(box.get(subId) as Y.Map<unknown>).set('type', 'deleted')
    const before = [...box.keys()].length
    expect(vfs.sweepStaleKeys()).toBe(1)
    expect(vfs.listFiles()).toEqual([])
    expect([...box.keys()].length).toBeLessThan(before)
  })
})

describe('checkMoved', () => {
  it('returns null when absent, non-string, or empty', () => {
    const doc = new Y.Doc()
    expect(checkMoved(doc)).toBeNull()
    doc.getMap().set('meta-301-moved', 42)
    expect(checkMoved(doc)).toBeNull()
    doc.getMap().set('meta-301-moved', '')
    expect(checkMoved(doc)).toBeNull()
  })
  it('splits new path from comment', () => {
    const doc = new Y.Doc()
    doc.getMap().set('meta-301-moved', 'srv::newdoc::tok::p\nmoved on friday\nuse this one')
    expect(checkMoved(doc)).toEqual({
      newDocumentPath: 'srv::newdoc::tok::p',
      comment: 'moved on friday\nuse this one',
    })
  })
  it('single line yields empty comment', () => {
    const doc = new Y.Doc()
    doc.getMap().set('meta-301-moved', 'srv::newdoc::tok::p')
    expect(checkMoved(doc)).toEqual({ newDocumentPath: 'srv::newdoc::tok::p', comment: '' })
  })
})

describe('parseHash', () => {
  it('parses the full 5-part form with tags', () => {
    expect(parseHash('srv::doc::tok::sub/f::ro,fast')).toEqual({
      server: 'srv',
      docname: 'doc',
      token: 'tok',
      path: 'sub/f',
      tags: ['ro', 'fast'],
    })
  })
  it('tolerates short forms, #-prefix, and leading slashes', () => {
    expect(parseHash('srv::doc')).toEqual({ server: 'srv', docname: 'doc', token: '', path: '', tags: [] })
    expect(parseHash('#srv::doc::tok::/sub')).toEqual({
      server: 'srv',
      docname: 'doc',
      token: 'tok',
      path: 'sub',
      tags: [],
    })
    expect(parseHash('srv::doc::tok::p::')).toEqual({
      server: 'srv',
      docname: 'doc',
      token: 'tok',
      path: 'p',
      tags: [],
    })
  })
  it('rejects empty server/docname', () => {
    expect(() => parseHash('::doc::tok')).toThrow()
    expect(() => parseHash('srv:: ::tok')).toThrow()
    expect(() => parseHash('single')).toThrow()
  })

  it('ensureFile is idempotent and never touches content', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    const t = vfs.ensureFile('sub/f.yaml')
    expect(t).toBeInstanceOf(Y.Text)
    expect(t.toString()).toBe('')
    t.insert(0, 'kept')
    expect(vfs.ensureFile('sub/f.yaml').toString()).toBe('kept')
    expect(vfs.ensureFile('sub/f.yaml')).toBe(t)
  })

  it('exists distinguishes files, dirs, and missing paths', () => {
    const doc = new Y.Doc()
    const vfs = openBox(doc, 'BOX/@/f', true)!
    expect(vfs.exists('nope')).toBeUndefined()
    expect(vfs.exists('')).toBeUndefined() // no root yet
    vfs.setFile('sub/f.yaml', 'x')
    expect(vfs.exists('sub/f.yaml')).toBe('file')
    expect(vfs.exists('sub')).toBe('dir')
    expect(vfs.exists('')).toBe('dir')
    expect(vfs.exists('sub/missing')).toBeUndefined()
  })
})
