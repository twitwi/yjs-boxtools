// Box-level entry points: from a Y.Doc + path to live handles.
//
// Two path flavors:
// - Plain map path ("BOX", "sub/folder"): the box IS the Y.Map at that
//   path under the doc root (same as yjs-datatools ensureMapPath/getY).
// - Full in-box path ("BOX/@/shop.yaml"): split at the first "/@/", open
//   the box part, resolve the file inside it. Only the exact "/@/" segment
//   is reserved.

import * as Y from 'yjs'
import { splitBoxPath } from './paths'
import { createVfs, type Vfs } from './vfs'

/** The Y.Map at a plain map path, creating nested maps when asked. */
export function openMap(doc: Y.Doc, mapPath: string, create: boolean): Y.Map<unknown> | undefined {
  const steps = mapPath.split('/').filter((s) => s !== '')
  let map: Y.Map<unknown> = doc.getMap()
  for (const step of steps) {
    const next = map.get(step)
    if (next instanceof Y.Map) {
      map = next as Y.Map<unknown>
    } else if (next === undefined && create) {
      const sub = new Y.Map<unknown>()
      map.set(step, sub)
      map = sub
    } else {
      return undefined
    }
  }
  return map
}

/** Open the box at a plain map path. create/init mirrors createVFS opts. */
export function openVfs(doc: Y.Doc, mapPath: string, create = false): Vfs | undefined {
  const map = openMap(doc, mapPath, create)
  return map ? createVfs(map) : undefined
}

/**
 * Open the box of `fullPath` ("BOX/@/shop.yaml" -> the "BOX" map's Vfs).
 * Returns undefined when the box is absent and create is false.
 * Pass create=true only after providers sync (see setup.whenReady):
 * concurrent creations orphan each other (children-key LWW).
 */
export function openBox(doc: Y.Doc, fullPath: string, create = false): Vfs | undefined {
  const { boxPath } = splitBoxPath(fullPath)
  return openVfs(doc, boxPath, create)
}

/**
 * Live Y.Text of the file at `fullPath`. Never creates unless asked.
 * With create=true, missing parents + an empty file are created (existing
 * content is never touched).
 */
export function getFileText(doc: Y.Doc, fullPath: string, create = false): Y.Text | undefined {
  const { innerPath } = splitBoxPath(fullPath)
  const vfs = openBox(doc, fullPath, create)
  if (!vfs) return undefined
  return create ? vfs.ensureFile(innerPath) : vfs.getFile(innerPath)
}

/**
 * File paths held by the box of `fullPath` (directories excluded).
 * Sorted, `[]` when absent.
 */
export function listBoxFiles(doc: Y.Doc, fullPath: string): string[] {
  return openBox(doc, fullPath, false)?.listFiles().filter((p) => !p.endsWith('/')) ?? []
}
