// Step 1 of the roundtrip fixture: build a box with YJS-BOXTOOLS and dump the
// encoded update for the legacy reader to inspect (see make-fixtures.ts).
//
//   npx tsx scripts/make-roundtrip.ts
//
// Deliberately a separate process from make-fixtures.ts: each side must run
// with its own `yjs` copy, otherwise the nominal `instanceof Y.Map` checks
// inside the legacy implementation fail across module instances.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { openVfs } from '../src/index'

const OUT_DIR = '/tmp/opencode-tmp'
const OUT = `${OUT_DIR}/yjs-boxtools-roundtrip.b64`

mkdirSync(OUT_DIR, { recursive: true })

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

writeFileSync(OUT, Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') + '\n')
console.log(`wrote ${OUT}`)
console.log('yjs-boxtools view:', vfs.listFiles().join(', '))
