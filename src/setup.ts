// Provider setup: Y.Doc + websocket + IndexedDB with a readiness gate.
//
// Nothing may be resolved or written before `whenReady` settles: it waits
// for IndexedDB + the first websocket sync, with a timeout so offline
// startup is never blocked. Splitting config parsing (pure) from connecting
// (effects) keeps this testable and UI-agnostic — prompting and localStorage
// stay in the app layer.

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import { SEP, type ParsedHash } from './paths'

export interface BoxConfig {
  server: string
  docname: string
  token: string
  boxPath: string
}

export function parseConfig(raw: string, defaultBoxPath: string): BoxConfig {
  const parts = raw.split(SEP).map((p) => p.trim())
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(`Invalid config (need server${SEP}doc${SEP}token[${SEP}boxpath]): ${raw}`)
  }
  const [server, docname, token] = parts
  // Token may be empty (some servers need none); server/docname must not be.
  if (!server || !docname) {
    throw new Error(`Invalid config (server and docname must be non-empty): ${raw}`)
  }
  return { server, docname, token, boxPath: parts[3] || defaultBoxPath }
}

export interface ConnectionOptions {
  websocket?: boolean
  indexeddb?: boolean
  idbKey?: string
  /** Cap on waiting for first sync; offline startup must never hang. */
  syncTimeoutMs?: number
}

export interface Connection {
  ydoc: Y.Doc
  provider: WebsocketProvider | null
  persistence: IndexeddbPersistence | null
  whenReady: Promise<void>
}

/**
 * Moved-document check (same semantics as yjs-datatools ysetup.ts).
 * Pure read, no UI: when the doc root holds a `meta-301-moved` string, the
 * document has moved — first line is the new document path, the rest is a
 * human comment. Returns null when absent, non-string, or empty.
 * Prompting/redirect policy stays in the app layer (it owns confirm(),
 * navigation, and the provider); this only reports the fact.
 */
export function checkMoved(ydoc: Y.Doc): { newDocumentPath: string; comment: string } | null {
  const moved = ydoc.getMap().get('meta-301-moved')
  if (typeof moved !== 'string' || !moved) return null
  const [newDocumentPath, ...rest] = moved.split('\n')
  return { newDocumentPath, comment: rest.join('\n') }
}

// Accepts BoxConfig or a ParsedHash (tags ride along, ignored here —
// read-only mode etc. is app policy, not connection policy). The box path
// is not needed to connect; resolving it is the box layer's job.
export function setupYjs(config: BoxConfig | ParsedHash, options: ConnectionOptions = {}): Connection {
  const { websocket = true, indexeddb = true, idbKey, syncTimeoutMs = 4000 } = options
  const ydoc = new Y.Doc()
  const provider = websocket
    ? new WebsocketProvider(
        config.server.includes('://') ? config.server : `wss://${config.server}`,
        `${config.docname}?t=${config.token}`,
        ydoc,
      )
    : null
  const persistence = indexeddb ? new IndexeddbPersistence(idbKey ?? `yjs-box-${config.docname}`, ydoc) : null

  // Both legs are capped: a wedged IndexedDB must never block startup (the
  // offline case), same as a missing server.
  const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const whenPersisted = persistence
    ? Promise.race([persistence.whenSynced.then(() => {}), after(syncTimeoutMs)])
    : Promise.resolve()
  const whenConnected = provider
    ? new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (!done) {
            done = true
            resolve()
          }
        }
        provider.on('sync', (synced: boolean) => {
          if (synced) finish()
        })
        setTimeout(finish, syncTimeoutMs)
      })
    : Promise.resolve()
  const whenReady = Promise.all([whenPersisted, whenConnected]).then(() => {})

  return { ydoc, provider, persistence, whenReady }
}
