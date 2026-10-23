# yjs-boxtools

A lean virtual-filesystem-in-a-box toolkit for [Yjs](https://yjs.dev): text and
binary files, directories, change watchers, and a provider setup with a
readiness gate. Framework-free — no Vue, no YAML, no app policy.

The box format is **compatible with `yjs-datatools` / codyjs**: same node
layout, opaque ids, names in the parent's children map, binary content base64
in a `Y.Text`. See [fixtures/](fixtures/README.md) for the executable proof.

## Install

Source-included TypeScript (bundled by your app; Vite/esbuild handle it).

```json
{ "dependencies": { "yjs-boxtools": "github:twitwi/yjs-boxtools" } }
```

Local development: `"yjs-boxtools": "file:../yjs-boxtools"`.

- Peer dependency: `yjs` (required).
- Optional peers: `y-websocket`, `y-indexeddb` — only `yjs-boxtools/setup` uses
  them, so importing `.` / `./vfs` / `./box` / `./watch` pulls neither.
- Internal imports are extensionless; use a bundler or
  `moduleResolution: "Bundler"`.

## Quick start

```ts
import * as Y from 'yjs'
import { openVfs, watchBox, setupYjs } from 'yjs-boxtools'
import { getFileText } from 'yjs-boxtools/box'

// Bring your own doc + provider, or let setup.ts wire them:
const { ydoc, provider, whenReady } = setupYjs({ server, docname, token, boxPath: 'BOX' })
await whenReady            // never resolve/write before this settles

const vfs = openVfs(ydoc, 'BOX', true)!   // create=true ONLY after sync
vfs.setFile('main.typ', '= Hello\n')
vfs.mkdir('img')
vfs.setFile('img/pixel.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
vfs.renameNode('main.typ', 'doc.typ')

const unwatch = watchBox(ydoc, 'BOX', (e) => {
  // e.type: 'created' | 'changed' | 'deleted'; e.path: string | null
})
```

## Layout / format

The box is a `Y.Map` under a plain map path (`"BOX"`, `"sub/folder"`):

- `root:` — root directory node.
- Directory node: `{ type: 'directory', parent, ctime, mtime, children: Y.Map<name, id> }`.
- File node: `{ type: 'text' | 'binary', parent, ctime, mtime, content: Y.Text }`.
  Binary content is base64 **text**; `type` is authoritative.
- Node ids are opaque (`id:…`); names exist **only** as keys in the parent's
  `children` map. Rename = key move. Concurrent creation of the same name
  resolves by LWW on that key — the loser's node is orphaned, never merged.
- In-box paths: `"BOX/@/file.typ"` (only the exact `/@/` segment is reserved);
  `splitBoxPath()` / `joinBoxPath()` handle the grammar.

## Modules

| Entry | What |
|---|---|
| `yjs-boxtools` (`src/index.ts`) | re-exports paths, vfs, box, watch |
| `yjs-boxtools/paths` | `parseHash`, `splitBoxPath`, `joinBoxPath`, `SEP`, `ROOT_ID` |
| `yjs-boxtools/vfs` | `createVfs(box)` → `Vfs` |
| `yjs-boxtools/box` | `openMap`, `openVfs`, `openBox`, `getFileText`, `listBoxFiles` |
| `yjs-boxtools/watch` | `watchBox`, `watchFile`, `pathOfId` |
| `yjs-boxtools/setup` | `setupYjs`, `parseConfig`, `checkMoved` |

`Vfs`: `listFiles`, `getFile`, `ensureFile`, `exists`, `readFileAsString`,
`readFileAsBytes`, `isBinary`, `setFile` (string | `Uint8Array`), `mkdir`,
`deleteNode`, `renameNode`, `isEmpty`, `sweepStaleKeys`, `description`.

## Error convention

- **Absent is silent and idempotent**: `getFile → undefined`,
  `readFileAsString → null`, `exists → undefined`, `isBinary → false`,
  delete/rename of a missing source → no-op. Safe under concurrent sync.
- **Programmer errors throw**: empty path, a file blocking a directory walk,
  writing where a directory lives, renaming onto an existing target.

The `undefined` vs `null` split is intentional: "no live object" vs "no
string value".

## Tombstones

yjs-boxtools deletes by unlinking and removing node maps — it never creates
tombstones. Legacy writers may leave stale keys pointing at
`type:'deleted'`/unknown/missing nodes; `sweepStaleKeys()` drops those keys and
reclaims the node maps they uniquely referenced (idempotent, sync-convergent).
Nodes an old writer already unlinked are unreachable and are **not** garbage
collected: scanning for unreachable ids is unsafe while a peer may be linking
a freshly created node.

## Sync rules (learned the hard way)

1. **Never create the box before sync.** Concurrent `create=true` on an
   unsynced doc gives every peer its own root map; root-key LWW orphans all
   but one, while everyone still reports `synced`. Wait for the first sync
   (`setupYjs(...).whenReady`, or `provider.on('sync')`).
2. **Bots/headless peers should use `disableBc: true`.** y-websocket's
   BroadcastChannel makes same-process peers sync synchronously, hiding
   network behavior.
3. **Let a disconnect settle before reconnecting.** `disconnect()` +
   immediate `connect()` races the close handshake and can leave a provider
   `synced` while missing updates (stable divergence).

## Interop & fixtures

`yjs-datatools` is frozen; yjs-boxtools is the new core. The format contract is
covered by fixtures generated from the legacy writer/reader — see
[fixtures/README.md](fixtures/README.md). Known intentional differences:

- Legacy `readFileAsString` returns raw base64 for binary nodes; yjs-boxtools
  decodes to UTF-8 text (lossy). Use `readFileAsBytes`.
- Legacy `setFile` does not create missing parents and silently falls back to
  the root; yjs-boxtools creates the parent chain.

## Development

```sh
npm install
npm test        # 35 unit + 7 conformance tests
npm run typecheck
```

`parseConfig` lives in `setup` for now but is app config policy (strict
`server::doc::token[::boxpath]`), a candidate to move back into the app layer.
