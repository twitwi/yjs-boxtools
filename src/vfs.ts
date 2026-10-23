// Minimal virtual filesystem on top of a Y.Map ("box").
//
// Layout: the box map holds nodes keyed by opaque ids. `root:` is the root
// directory node. Directory nodes are `{ type: 'directory', children:
// Y.Map<name, id> }`; file nodes are `{ type: 'text' | 'binary', content:
// Y.Text }` (binary content is base64). Names live ONLY in the parent's
// children map, so renames are one key move and concurrent creations of the
// same name resolve by LWW on that key (the loser's node is orphaned and
// ignored — never merged). Unknown/legacy node types are skipped on read.

import * as Y from 'yjs'
import { ROOT_ID } from './paths'

const TYPE = 'type'
const CHILDREN = 'children'
const CONTENT = 'content'

export interface Vfs {
  // Error convention (applies to every method below):
  // - Resolving something absent is silent and idempotent: getFile ->
  //   undefined, readFileAsString -> null, exists -> undefined, isBinary ->
  //   false, deleteNode/renameNode of a missing source -> no-op. Safe
  //   under concurrent sync.
  // - Programmer errors throw: empty path, a file blocking a directory
  //   walk, writing where a directory lives, renaming onto an existing
  //   target.
  // Missing-signal pairing is intentional, not drift: getFile -> undefined
  // (no live object), readFileAsString -> null (no string value). Do not
  // "unify".
  //
  /** The underlying box map. Observe it (observeDeep) for change tracking. */
  readonly description: Y.Map<unknown>
  /** All entries, directories with trailing `/`. Sorted. */
  listFiles(): string[]
  /** Live Y.Text of a file (text or binary), or undefined. Never creates. */
  getFile(path: string): Y.Text | undefined
  /** Like getFile, but creates parents + an empty text file when absent. */
  ensureFile(path: string): Y.Text
  /** 'file' | 'dir' for live entries, undefined when absent. */
  exists(path: string): 'file' | 'dir' | undefined
  /** File content as string (binary decoded as UTF-8), null when absent. */
  readFileAsString(path: string): string | null
  /** File content as bytes (binary base64-decoded), null when absent. */
  readFileAsBytes(path: string): Uint8Array | null
  /** True when the live entry is a binary file. */
  isBinary(path: string): boolean
  /**
   * Create parents + file as needed; replaces content wholesale.
   * Uint8Array (or sniffed-binary strings) become binary nodes.
   */
  setFile(path: string, content: string | Uint8Array): void
  /** Create a directory chain (idempotent; '' ensures the root). */
  mkdir(path: string): void
  /** Unlink a file or directory (recursive). No tombstones. */
  deleteNode(path: string): void
  /** Move within the box (may cross directories), creating target parents. */
  renameNode(oldPath: string, newPath: string): void
  /** True when the box holds no live entries. */
  isEmpty(): boolean
  /**
   * Drop children entries pointing at missing, tombstoned (`deleted`), or
   * unknown-type nodes, reclaiming singly-referenced node maps. Needed after
   * interop with writers that leave stale keys (e.g. codyjs tombstones);
   * our own deletes never create them. Idempotent, sync-convergent.
   * Returns the number of dropped entries.
   */
  sweepStaleKeys(): number
}

function stepsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '')
}

function nodeOf(box: Y.Map<unknown>, id: string): Y.Map<unknown> | undefined {
  const n = box.get(id)
  return n instanceof Y.Map ? (n as Y.Map<unknown>) : undefined
}

function childrenOf(dir: Y.Map<unknown>): Y.Map<string> | undefined {
  if (dir.get(TYPE) !== 'directory') return undefined
  const c = dir.get(CHILDREN)
  return c instanceof Y.Map ? (c as Y.Map<string>) : undefined
}

function contentOf(file: Y.Map<unknown>): Y.Text | undefined {
  if (file.get(TYPE) !== 'text' && file.get(TYPE) !== 'binary') return undefined
  const c = file.get(CONTENT)
  return c instanceof Y.Text ? c : undefined
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return 'id:' + crypto.randomUUID().slice(0, 8)
  }
  return 'id:' + Math.random().toString(36).slice(2, 10)
}

function makeDir(parentId: string): Y.Map<unknown> {
  const t = Date.now()
  const dir = new Y.Map<unknown>()
  dir.set(TYPE, 'directory')
  dir.set('parent', parentId)
  dir.set('ctime', t)
  dir.set('mtime', t)
  dir.set(CHILDREN, new Y.Map<string>())
  return dir
}

function isProbablyBinary(content: string): boolean {
  if (!content) return false
  for (let i = 0; i < Math.min(1024, content.length); i++) {
    const c = content.charCodeAt(i)
    if (c === 0 || c === 0xfffd) return true
  }
  return false
}

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Fetch the root, creating it when asked. Never throws on shape mismatch. */
function root(box: Y.Map<unknown>, create: boolean): Y.Map<unknown> | undefined {
  const r = nodeOf(box, ROOT_ID)
  if (r) return childrenOf(r) ? r : undefined
  if (!create) return undefined
  const dir = makeDir('')
  box.set(ROOT_ID, dir)
  return dir
}

/** Walk to the parent dir of `steps`, creating missing dirs when asked. */
function parentDir(
  box: Y.Map<unknown>,
  steps: string[],
  create: boolean,
): { dir: Y.Map<unknown>; dirId: string; name: string } | undefined {
  const r = root(box, create)
  if (!r) return undefined
  const name = steps[steps.length - 1]
  let dir = r
  let dirId = ROOT_ID
  for (const part of steps.slice(0, -1)) {
    const children = childrenOf(dir)
    if (!children) return undefined
    const childId = children.get(part)
    const child = childId ? nodeOf(box, childId) : undefined
    if (child && childrenOf(child)) {
      dir = child
      dirId = childId as string
    } else if (child || !create) {
      return undefined // a file blocks the way, or nothing to create with
    } else {
      const id = newId()
      const sub = makeDir(dirId)
      box.set(id, sub)
      children.set(part, id)
      dir = sub
      dirId = id
    }
  }
  return { dir, dirId, name }
}

export function createVfs(box: Y.Map<unknown>): Vfs {
  function listFiles(): string[] {
    const r = root(box, false)
    const out: string[] = []
    if (!r) return out
    const walk = (dir: Y.Map<unknown>, prefix: string) => {
      const children = childrenOf(dir)
      if (!children) return
      for (const [name, id] of children) {
        const sub = nodeOf(box, id)
        if (!sub) continue
        if (childrenOf(sub)) {
          out.push(`${prefix}${name}/`)
          walk(sub, `${prefix}${name}/`)
        } else if (contentOf(sub)) {
          out.push(prefix + name)
        }
        // unknown / legacy node types are skipped, never surfaced
      }
    }
    walk(r, '')
    return out.sort()
  }

  function nodeAt(steps: string[]): Y.Map<unknown> | undefined {
    const found = parentDir(box, steps, false)
    if (!found) return undefined
    const id = childrenOf(found.dir)?.get(found.name)
    return id ? nodeOf(box, id) : undefined
  }

  function getFile(path: string): Y.Text | undefined {
    const steps = stepsOf(path)
    if (steps.length === 0) return undefined
    const node = nodeAt(steps)
    return node ? contentOf(node) : undefined
  }

  function ensureFile(path: string): Y.Text {
    const steps = stepsOf(path)
    if (steps.length === 0) throw new Error('Path cannot be empty')
    const live = getFile(path)
    if (live) return live
    const found = parentDir(box, steps, true)
    if (!found) throw new Error(`Cannot create parent directories for: ${path}`)
    const children = childrenOf(found.dir)
    if (!children) throw new Error(`Not a directory: ${path}`)
    if (children.get(found.name) !== undefined) {
      throw new Error(`Path exists and is not a file: ${path}`)
    }
    const id = newId()
    const file = new Y.Map<unknown>()
    const t = Date.now()
    file.set(TYPE, 'text')
    file.set('parent', found.dirId)
    file.set('ctime', t)
    file.set('mtime', t)
    const text = new Y.Text()
    file.set(CONTENT, text)
    box.set(id, file)
    children.set(found.name, id)
    return text
  }

  function exists(path: string): 'file' | 'dir' | undefined {
    const steps = stepsOf(path)
    if (steps.length === 0) return root(box, false) ? 'dir' : undefined
    const node = nodeAt(steps)
    if (!node) return undefined
    if (childrenOf(node)) return 'dir'
    return contentOf(node) ? 'file' : undefined
  }

  function readFileAsString(path: string): string | null {
    const steps = stepsOf(path)
    if (steps.length === 0) return null
    const node = nodeAt(steps)
    const text = node ? contentOf(node) : undefined
    if (!text) return null
    if (node?.get(TYPE) === 'binary') {
      try {
        return new TextDecoder().decode(base64Decode(text.toString()))
      } catch {
        return null
      }
    }
    return text.toString()
  }

  function readFileAsBytes(path: string): Uint8Array | null {
    const steps = stepsOf(path)
    if (steps.length === 0) return null
    const node = nodeAt(steps)
    const text = node ? contentOf(node) : undefined
    if (!text) return null
    if (node?.get(TYPE) === 'binary') {
      try {
        return base64Decode(text.toString())
      } catch {
        return null
      }
    }
    return new TextEncoder().encode(text.toString())
  }

  function isBinary(path: string): boolean {
    const steps = stepsOf(path)
    if (steps.length === 0) return false
    return nodeAt(steps)?.get(TYPE) === 'binary'
  }

  function setFile(path: string, content: string | Uint8Array): void {
    const steps = stepsOf(path)
    if (steps.length === 0) throw new Error('Path cannot be empty')
    const found = parentDir(box, steps, true)
    if (!found) throw new Error(`Cannot create parent directories for: ${path}`)
    const children = childrenOf(found.dir)
    if (!children) throw new Error(`Not a directory: ${path}`)
    const strContent = typeof content === 'string' ? content : base64Encode(content)
    const wantBinary = content instanceof Uint8Array || isProbablyBinary(strContent)
    const existingId = children.get(found.name)
    const existing = existingId ? nodeOf(box, existingId) : undefined
    const existingText = existing ? contentOf(existing) : undefined
    if (existingText) {
      existingText.delete(0, existingText.length)
      existingText.insert(0, strContent)
      existing!.set('mtime', Date.now())
      if (wantBinary && existing!.get(TYPE) !== 'binary') existing!.set(TYPE, 'binary')
      return
    }
    if (existing) throw new Error(`Path exists and is not a file: ${path}`)
    const id = newId()
    const t = Date.now()
    const file = new Y.Map<unknown>()
    file.set(TYPE, wantBinary ? 'binary' : 'text')
    file.set('parent', found.dirId)
    file.set('ctime', t)
    file.set('mtime', t)
    file.set(CONTENT, new Y.Text(strContent))
    box.set(id, file)
    children.set(found.name, id)
  }

  function mkdir(path: string): void {
    const steps = stepsOf(path)
    const r = root(box, true)
    if (!r) throw new Error(`Cannot initialize box for: ${path}`)
    let dir = r
    let dirId = ROOT_ID
    for (const part of steps) {
      const children = childrenOf(dir)
      if (!children) throw new Error(`Not a directory: ${path}`)
      const childId = children.get(part)
      const child = childId ? nodeOf(box, childId) : undefined
      if (child && childrenOf(child)) {
        dir = child
        dirId = childId as string
      } else if (child) {
        throw new Error(`Path segment "${part}" is not a directory`)
      } else {
        const id = newId()
        const sub = makeDir(dirId)
        box.set(id, sub)
        children.set(part, id)
        dir = sub
        dirId = id
      }
    }
  }

  function deleteNode(path: string): void {
    const steps = stepsOf(path)
    if (steps.length === 0) return
    const found = parentDir(box, steps, false)
    if (!found) return
    const children = childrenOf(found.dir)
    const id = children?.get(found.name)
    if (!id) return
    const drop = (nodeId: string) => {
      const n = nodeOf(box, nodeId)
      if (!n) return
      const c = childrenOf(n)
      if (c) for (const [, childId] of c) drop(childId)
      box.delete(nodeId)
    }
    drop(id)
    children?.delete(found.name)
  }

  function renameNode(oldPath: string, newPath: string): void {
    const from = stepsOf(oldPath)
    const to = stepsOf(newPath)
    if (from.length === 0 || to.length === 0) throw new Error('Path cannot be empty')
    const src = parentDir(box, from, false)
    if (!src) return
    const srcChildren = childrenOf(src.dir)
    const id = srcChildren?.get(src.name)
    if (!id) return
    const target = parentDir(box, to, true)
    if (!target) throw new Error(`Cannot create parent directories for: ${newPath}`)
    const targetChildren = childrenOf(target.dir)
    if (!targetChildren) throw new Error(`Not a directory: ${newPath}`)
    if (targetChildren.get(target.name) !== undefined) {
      throw new Error(`Target already exists: ${newPath}`)
    }
    srcChildren?.delete(src.name)
    targetChildren.set(target.name, id)
    // Keep the parent link (used by id->path resolution) in sync with the
    // children-key move; bump mtime like a content write.
    const moved = nodeOf(box, id)
    if (moved) {
      moved.set('parent', target.dirId)
      moved.set('mtime', Date.now())
    }
  }

  function isEmpty(): boolean {
    return listFiles().length === 0
  }

  function sweepStaleKeys(): number {
    const r = root(box, false)
    if (!r) return 0
    // Reference counts first: never drop a node map another key still links.
    const refs = new Map<string, number>()
    const dirs: Y.Map<unknown>[] = [r]
    const seenDirs = new Set<Y.Map<unknown>>([r])
    for (let i = 0; i < dirs.length; i++) {
      const children = childrenOf(dirs[i])
      if (!children) continue
      for (const [, cid] of children) {
        refs.set(cid, (refs.get(cid) ?? 0) + 1)
        const sub = nodeOf(box, cid)
        if (sub && childrenOf(sub) && !seenDirs.has(sub)) {
          seenDirs.add(sub)
          dirs.push(sub)
        }
      }
    }
    const dropSubtree = (nodeId: string) => {
      // Called after the unlinking key was already decremented: drop only
      // when no live key references the node anymore.
      if ((refs.get(nodeId) ?? 0) > 0) return
      refs.set(nodeId, 0)
      const n = nodeOf(box, nodeId)
      if (!n) return
      const c = childrenOf(n)
      if (c) {
        for (const [, cid] of [...c]) {
          refs.set(cid, (refs.get(cid) ?? 0) - 1)
          dropSubtree(cid)
        }
      }
      box.delete(nodeId)
    }
    let dropped = 0
    for (const dir of dirs) {
      const children = childrenOf(dir)
      if (!children) continue
      for (const [name, cid] of [...children]) {
        const target = nodeOf(box, cid)
        const live = target !== undefined && (childrenOf(target) !== undefined || contentOf(target) !== undefined)
        if (!live) {
          children.delete(name)
          refs.set(cid, (refs.get(cid) ?? 0) - 1)
          dropSubtree(cid)
          dropped++
        }
      }
    }
    return dropped
  }

  return {
    description: box,
    listFiles,
    getFile,
    ensureFile,
    exists,
    readFileAsString,
    readFileAsBytes,
    isBinary,
    setFile,
    mkdir,
    deleteNode,
    renameNode,
    isEmpty,
    sweepStaleKeys,
  }
}
