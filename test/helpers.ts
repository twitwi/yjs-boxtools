import * as Y from 'yjs'
import { getFileText } from '../src/index'

/** Fresh doc with one file (created, so writers apply). */
export function newDocWithFile(fullPath: string, content: string): Y.Doc {
  const doc = new Y.Doc()
  const t = getFileText(doc, fullPath, true)!
  t.delete(0, t.length)
  t.insert(0, content)
  return doc
}
