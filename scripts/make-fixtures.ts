// Generates the conformance fixtures. Run ONCE, with the yjs-datatools
// checkout's tsx, because the legacy implementation must run on its own
// `yjs` module instance:
//
//   cd ~/shared/apps/yjs-datatools && npx tsx <yjs-boxtools>/scripts/make-fixtures.ts
//
// Prerequisite for the roundtrip report: run scripts/make-roundtrip.ts first
// with yjs-boxtools' own tsx (it writes /tmp/opencode-tmp/yjs-boxtools-roundtrip.b64).
//
// Outputs (all under ../fixtures/):
//   legacy-clean.b64        box written purely through the legacy API
//   legacy-clean.report.json   what the legacy reader saw in it
//   legacy-dirty.b64        box with stale keys/tombstones/unknown types
//   legacy-dirty.report.json   expected sweep result + ids to keep/drop
//   roundtrip.report.json   legacy reader's view of a yjs-boxtools-written box
//
// The fixtures are a contract: regenerating them is a format decision.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(HERE, '../fixtures')
const DATATOOLS = process.env.YJS_DATATOOLS
  ?? resolve(HERE, '../../../../shared/apps/yjs-datatools')

const Y: any = await import(
  pathToFileURL(join(DATATOOLS, 'node_modules/yjs/dist/yjs.mjs')).href
)
const { createVFS }: any = await import(pathToFileURL(join(DATATOOLS, 'vfs.ts')).href)

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64') + '\n'
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const writeJson = (name: string, value: unknown) =>
  writeFileSync(join(FIXTURES, name), JSON.stringify(value, null, 2) + '\n')

/** What the legacy reader reports for a doc's BOX map. */
function legacyReport(doc: any) {
  const box = doc.getMap().get('BOX') as any
  const vfs = createVFS(box)
  const entries: Record<string, unknown> = {}
  for (const file of vfs.listFiles()) {
    if (file.endsWith('/')) continue
    const bytes = vfs.readFileAsBytes(file)
    entries[file] = {
      str: vfs.readFileAsString(file),
      bytesHex: bytes ? hex(bytes) : null,
      isBinary: vfs.isBinary(file),
    }
  }
  return {
    updateSha256: sha256(Y.encodeStateAsUpdate(doc)),
    isEmpty: vfs.isEmpty(),
    files: vfs.listFiles(),
    entries,
  }
}

function newBox() {
  const doc = new Y.Doc()
  const box = new Y.Map()
  doc.getMap().set('BOX', box)
  return { doc, box, vfs: createVFS(box, true) }
}

// ── 1. clean: written entirely through the legacy API ────────────────────────
{
  const { doc, vfs } = newBox()
  vfs.setFile('notes.txt', 'note\n')
  vfs.setFile('readme.md', '# hello\nline2\n')
  vfs.mkdir('dir/inner')
  vfs.setFile('dir/inner/deep.typ', '= Deep\nline\n')
  vfs.renameNode('dir/inner/deep.typ', 'dir/moved.typ')
  vfs.mkdir('img') // legacy setFile does NOT create parents: without this the
  // file would silently land at the root as 'pixel.png'
  vfs.setFile(
    'img/pixel.png',
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  )
  vfs.deleteNode('readme.md')

  writeFileSync(join(FIXTURES, 'legacy-clean.b64'), b64(Y.encodeStateAsUpdate(doc)))
  writeJson('legacy-clean.report.json', legacyReport(doc))
}

// ── 2. dirty: what buggy/legacy writers leave behind ────────────────────────
{
  const { doc, box, vfs } = newBox()
  const rootChildren = (box.get('root:') as any).get('children')

  // codyjs-style tombstone: node marked deleted, parent key kept.
  vfs.mkdir('stale')
  vfs.setFile('stale/keep-key.txt', 'tombstone with kept key\n')
  const staleDir = (rootChildren.get('stale') ? box.get(rootChildren.get('stale')) : null) as any
  const keepKeyId = staleDir.get('children').get('keep-key.txt') as string
  box.get(keepKeyId).set('type', 'deleted')

  // Caller-supplied bad data: key pointing at a missing node.
  rootChildren.set('ghost.txt', 'id:does-not-exist')

  // Unknown legacy node type.
  vfs.setFile('link.txt', 'not really a file\n')
  const linkId = rootChildren.get('link.txt') as string
  box.get(linkId).set('type', 'link')

  // Nested stale key (sweep must recurse).
  vfs.mkdir('dir')
  vfs.setFile('dir/keep.typ', 'keep me\n')
  const dirId = rootChildren.get('dir') as string
  const dirChildren = box.get(dirId).get('children') as any
  dirChildren.set('gone.typ', 'id:nope')

  // Orphan tombstone with no stale key (legacy deleteNode behavior):
  // the sweep never reclaims it (documented limitation).
  vfs.setFile('dir/orphan.txt', 'orphan\n')
  const orphanId = dirChildren.get('orphan.txt') as string
  vfs.deleteNode('dir/orphan.txt')

  // Doc-level moved marker (exercises checkMoved from real bytes).
  doc.getMap().set('meta-301-moved', 'NEW/DOC\nmoved comment')

  writeFileSync(join(FIXTURES, 'legacy-dirty.b64'), b64(Y.encodeStateAsUpdate(doc)))
  writeJson('legacy-dirty.report.json', {
    updateSha256: sha256(Y.encodeStateAsUpdate(doc)),
    files: ['dir/', 'dir/keep.typ', 'stale/'],
    dropped: 4,
    reclaimedIds: [keepKeyId, linkId],
    orphanId,
    moved: { newDocumentPath: 'NEW/DOC', comment: 'moved comment' },
  })
}

// ── 3. roundtrip: legacy reads a box that YJS-BOXTOOLS wrote ────────────────────
{
  const path = '/tmp/opencode-tmp/yjs-boxtools-roundtrip.b64'
  if (!existsSync(path)) {
    console.warn(`skip roundtrip: ${path} missing (run scripts/make-roundtrip.ts first)`)
  } else {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')))
    writeJson('roundtrip.report.json', legacyReport(doc))
  }
}

console.log('fixtures written to', FIXTURES)
