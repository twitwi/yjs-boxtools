// Change notifications for boxes and files.
//
// Framework-agnostic (no vue/vscode imports): consumers map BoxEvents to
// their own world (VS Code FileChangeEvents, a vue version counter, ...).
// Batching mirrors codyjs's `_fireSoon` (5ms): a sync burst of Yjs events
// produces one callback invocation.

import * as Y from 'yjs'
import { ROOT_ID } from './paths'
import type { Vfs } from './vfs'

type DeepListener = (events: Y.YEvent<any>[], tr: Y.Transaction) => void

export type BoxEventType = 'created' | 'changed' | 'deleted'

export interface BoxEvent {
  type: BoxEventType
  /** Best-effort path; null when unresolvable (consumer re-lists). */
  path: string | null
}

function isMap(v: unknown): v is Y.Map<unknown> {
  return v instanceof Y.Map
}

function dirChildren(node: Y.Map<unknown>): Y.Map<string> | undefined {
  if (node.get('type') !== 'directory') return undefined
  const c = node.get('children')
  return isMap(c) ? (c as Y.Map<string>) : undefined
}

/** id -> path via parent links. Null when any link is missing/stale. */
export function pathOfId(box: Y.Map<unknown>, id: string): string | null {
  if (id === ROOT_ID) return ''
  const parts: string[] = []
  let cur: string | undefined = id
  const seen = new Set<string>()
  while (cur !== ROOT_ID) {
    if (!cur || seen.has(cur)) return null
    seen.add(cur)
    const node = box.get(cur)
    if (!isMap(node)) return null
    const parent = node.get('parent')
    if (typeof parent !== 'string' || !parent) return null
    const pNode = box.get(parent)
    if (!isMap(pNode)) return null
    const children = dirChildren(pNode)
    if (!children) return null
    let name: string | undefined
    for (const [n, cid] of children) {
      if (cid === cur) {
        name = n
        break
      }
    }
    if (name === undefined) return null
    parts.unshift(name)
    cur = parent
  }
  return parts.join('/')
}

/** Locate the (dirPath, key) of a children-map change, or null. */
function ownerOfChildren(box: Y.Map<unknown>, target: Y.Map<unknown>): { dirPath: string; dirId: string } | null {
  const root = box.get(ROOT_ID)
  if (!isMap(root)) return null
  const stack: { id: string; path: string }[] = [{ id: ROOT_ID, path: '' }]
  while (stack.length > 0) {
    const { id, path } = stack.pop()!
    const node = box.get(id)
    if (!isMap(node)) continue
    const children = dirChildren(node)
    if (!children) continue
    if (children === (target as unknown)) return { dirPath: path, dirId: id }
    for (const [name, cid] of children) {
      const sub = box.get(cid)
      if (isMap(sub) && dirChildren(sub)) {
        stack.push({ id: cid, path: path ? `${path}/${name}` : name })
      }
    }
  }
  return null
}

/** Locate the id of a node map or content Y.Text. Null when detached. */
function idOfTarget(box: Y.Map<unknown>, target: Y.Map<unknown> | Y.Text): string | null {
  for (const key of box.keys()) {
    const node = box.get(key)
    if (node === (target as unknown)) return key
    if (isMap(node) && node.get('content') === (target as unknown)) return key
  }
  return null
}

/**
 * Observe structural + content changes of a box. Batched: one callback per
 * 5ms flush window. Returns unwatch (also clears a pending flush).
 */
export function watchBox(box: Y.Map<unknown>, cb: (events: BoxEvent[]) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<string | null, BoxEventType>()

  const push = (path: string | null, type: BoxEventType) => {
    const prev = pending.get(path)
    // created+deleted in one window collapses to deleted; deleted+created
    // to created; anything involving changed stays changed-safe: changed wins
    // unless the pair is a pure create-then-remove (deleted) or
    // remove-then-create (created).
    if (prev === undefined) {
      pending.set(path, type)
    } else if (prev === 'created' && type === 'deleted') {
      pending.set(path, 'deleted')
    } else if (prev === 'deleted' && type === 'created') {
      pending.set(path, 'created')
    } else if (type === 'changed' || prev === 'changed') {
      pending.set(path, 'changed')
    }
  }

  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (pending.size === 0) return
      const events: BoxEvent[] = [...pending].map(([path, type]) => ({ type, path }))
      pending.clear()
      cb(events)
    }, 5)
  }

  const listener: DeepListener = (events, _tr) => {
    for (const ev of events) {
      const target = ev.target as unknown as Y.Map<unknown> | Y.Text
      if (ev instanceof Y.YMapEvent) {
        if (target === (box as unknown)) {
          // node maps added/removed at top level: ids, not paths
          for (const key of ev.keysChanged) {
            const id = idOfTarget(box, box.get(key) as Y.Map<unknown>)
            push(id ? pathOfId(box, id) : null, ev.changes.keys.get(key)?.action === 'delete' ? 'deleted' : 'changed')
          }
          schedule()
          continue
        }
        const owner = isMap(target) ? ownerOfChildren(box, target) : null
        if (owner) {
          // children-map change: keys are file/dir names -> real paths
          for (const key of ev.keysChanged) {
            const action = ev.changes.keys.get(key)?.action
            const p = owner.dirPath ? `${owner.dirPath}/${key}` : key
            push(p, action === 'delete' ? 'deleted' : action === 'add' ? 'created' : 'changed')
          }
        } else if (isMap(target)) {
          // node attribute change (mtime/type/...): resolve via id
          const id = idOfTarget(box, target)
          push(id ? pathOfId(box, id) : null, 'changed')
        } else {
          push(null, 'changed')
        }
      } else {
        // YTextEvent (file content) or YArrayEvent: resolve owning file
        const id = idOfTarget(box, target)
        push(id ? pathOfId(box, id) : null, 'changed')
      }
    }
    schedule()
  }

  box.observeDeep(listener)
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    pending.clear()
    box.unobserveDeep(listener)
  }
}

/**
 * Observe one file's content. Re-resolves the live Y.Text on every flush,
 * so delete/recreate cycles are tracked (callback gets null while absent).
 * Silent on identical content. Returns unwatch.
 */
export function watchFile(vfs: Vfs, path: string, cb: (content: string | null) => void): () => void {
  let bound: Y.Text | null = null
  let last: string | null | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const emit = () => {
    timer = undefined
    const live = vfs.getFile(path) ?? null
    if (live !== bound) {
      if (bound) bound.unobserve(onText)
      bound = live
      if (bound) bound.observe(onText)
    }
    const cur = bound ? bound.toString() : null
    if (cur !== last) {
      last = cur
      cb(cur)
    }
  }

  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(emit, 5)
  }

  const onText = () => schedule()
  const onBox = () => schedule()

  vfs.description.observeDeep(onBox as DeepListener)
  // Prime without notifying: first real change (or an initial explicit read
  // by the consumer) drives the first callback.
  bound = vfs.getFile(path) ?? null
  if (bound) bound.observe(onText)
  last = bound ? bound.toString() : null

  return () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    vfs.description.unobserveDeep(onBox as DeepListener)
    if (bound) bound.unobserve(onText)
    bound = null
  }
}
