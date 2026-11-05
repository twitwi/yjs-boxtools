import { describe, expect, it, vi } from 'vitest'
import type { Doc } from 'yjs'
import { setupYjs } from '../src/setup'

// Only the plumbing is under test: which legs setupYjs opens and what it hands to
// y-websocket. Both providers are mocked, so no socket and no IndexedDB.
const seen = vi.hoisted(() => ({
  providers: [] as Array<{ server: string; room: string; opts: Record<string, unknown> }>,
  persisted: [] as string[],
}))

vi.mock('y-websocket', () => ({
  WebsocketProvider: class {
    synced = true
    constructor(server: string, room: string, _doc: Doc, opts: Record<string, unknown> = {}) {
      seen.providers.push({ server, room, opts })
    }
    on() {}
    disconnect() {}
  },
}))

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    whenSynced = Promise.resolve()
    constructor(key: string) {
      seen.persisted.push(key)
    }
    disconnect() {}
  },
}))

const config = { server: 's.example.org', docname: 'doc1', token: 'TOK', boxPath: 'BOX' }
const lastProvider = () => seen.providers[seen.providers.length - 1]

describe('setupYjs', () => {
  it('keeps cross-tab sync (the BroadcastChannel) on by default', () => {
    setupYjs(config, { indexeddb: false, syncTimeoutMs: 5 })
    expect(lastProvider()?.opts).toEqual({ disableBc: false })
  })

  it('bc: false reaches y-websocket as disableBc', () => {
    setupYjs(config, { indexeddb: false, bc: false, syncTimeoutMs: 5 })
    expect(lastProvider()?.opts).toEqual({ disableBc: true })
  })

  it('opens the legs it was asked for, room named after doc and token', async () => {
    const { provider, persistence, whenReady } = setupYjs(config, { bc: false, syncTimeoutMs: 5 })
    await whenReady // the websocket never syncs here: the cap is what settles it
    expect(provider).not.toBeNull()
    expect(lastProvider()?.server).toBe('wss://s.example.org')
    expect(lastProvider()?.room).toBe('doc1?t=TOK')
    expect(persistence).not.toBeNull() // indexeddb still defaults to true
    expect(seen.persisted[seen.persisted.length - 1]).toBe('yjs-box-doc1')
  })

  it('opens no provider at all when the websocket is off', () => {
    const { provider, persistence } = setupYjs(config, { websocket: false, indexeddb: false })
    expect(provider).toBeNull()
    expect(persistence).toBeNull()
  })
})
