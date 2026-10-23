# Conformance fixtures

Static contracts for the on-disk box format, produced by **other**
implementations. Unit tests pin yjs-boxtools' own expectations; these pin what
the rest of the ecosystem actually wrote.

**Treat them as immutable.** Regenerating is a format decision: review the
diff, update `test/fixtures.spec.ts` expectations, and note the change here.

## Provenance

| | |
|---|---|
| Generated | 2026-10-23 |
| Legacy writer | `yjs-datatools` @ `52830d8` (v0.2.1) |
| yjs | 13.6.29 |
| Node | v26.8.1 |

Each `.b64` is a base64 `Y.encodeStateAsUpdate()` of a doc whose box lives at
root key `BOX`. Byte-level integrity is checked by the `updateSha256` field in
the companion report.

## Files

| File | Written by | Purpose |
|---|---|---|
| `legacy-clean.b64` | yjs-datatools API only | text, nested dirs, cross-dir rename, binary (PNG bytes), a legacy `deleteNode`, and the `parent: ''` quirk |
| `legacy-clean.report.json` | yjs-datatools reader | `listFiles` / `isEmpty` / per-file `str`, `bytesHex`, `isBinary` to assert exact equality |
| `legacy-dirty.b64` | legacy API + direct map mutations | stale and tombstoned keys, unknown node type, missing target ids, doc-level moved marker |
| `legacy-dirty.report.json` | hand-written from the cases | expected live file list, `dropped` count, `reclaimedIds`, `orphanId`, moved payload |
| `roundtrip.report.json` | yjs-datatools reader on a yjs-boxtools-written box | proves the legacy reader can consume what yjs-boxtools writes |

## Dirty-box cases (and expected yjs-boxtools behavior)

- **`stale/keep-key.txt`** — node `type:'deleted'`, parent children key kept
  (codyjs `_markDeleted` without a name). Not listed; `sweepStaleKeys()` drops
  the key and reclaims the node map.
- **`ghost.txt`** — children key → `id:does-not-exist`. Not listed; sweep drops
  the key.
- **`link.txt`** — node with unknown `type:'link'`. Not listed; sweep drops the
  key and reclaims the node map.
- **`dir/gone.typ`** — nested stale key. Sweep must recurse into `dir/`.
- **`dir/orphan.txt`** — tombstoned by legacy `deleteNode`, which already
  unlinked the key. Unreachable garbage; the sweep **does not** reclaim it
  (scanning-and-GC'ing unreachable ids is unsafe with concurrent writers).
- **`meta-301-moved`** on the doc root — `checkMoved()` reports
  `{ newDocumentPath: 'NEW/DOC', comment: 'moved comment' }`.

Total stale keys dropped: **4**; second sweep: **0**.

## Regeneration

Two processes on purpose: each side must use its **own** `yjs` instance, or
the legacy implementation's `instanceof Y.Map` checks fail across copies.

```sh
# 1. yjs-boxtools writes the roundtrip box (uses yjs-boxtools' own yjs)
cd <yjs-boxtools>
npx tsx scripts/make-roundtrip.ts          # -> /tmp/opencode-tmp/yjs-boxtools-roundtrip.b64

# 2. legacy writes clean/dirty and reads the roundtrip box
cd ~/shared/apps/yjs-datatools
npx tsx <yjs-boxtools>/scripts/make-fixtures.ts
```

`make-fixtures.ts` defaults to `../../../../shared/apps/yjs-datatools`; override
with `YJS_DATATOOLS=/path/to/yjs-datatools`.

## Legacy quirks captured here

- `setFile('a/b.txt', …)` does **not** create `a/`. With missing parents the
  legacy writer silently places the file at the **root** under the basename.
  (Always `mkdir` parents first.)
- Legacy file nodes are created with `parent: ''`; traversal never relies on
  `parent`, so readers must not either.
- Legacy `readFileAsString` returns the raw base64 for binary nodes, whereas
  yjs-boxtools decodes to text (lossy). Compare binary content by bytes.
- Legacy `listFiles` includes directories with a trailing `/`; yjs-boxtools
  matches. `listBoxFiles()` is the file-only convenience.
- Legacy `deleteNode` tombstones the node then unlinks the parent key; the
  tombstoned map stays in the box but is unreachable.
