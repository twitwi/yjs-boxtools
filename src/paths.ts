// Path grammar for in-box file references.
//
// A full path is "<box-path>/@/<inner-path>", e.g. "BOX/@/shop.yaml" or
// "BOX/@/lists/old.yaml". Only the exact "/@/" segment is reserved — names
// containing "@" or spaces are fine everywhere else. Splitting happens at
// the FIRST "/@/" occurrence, so inner paths can never confuse the parser.

export const SEP = '::'
export const TAGSEP = ','
export const BOX_MARKER = '@'
export const ROOT_ID = 'root:'

// Hash config grammar (same as yjs-datatools hash.ts):
// "server::docname::token::path::tag1,tag2". Only server + docname are
// required; token may be empty; path/tags default to ''. A leading '#'
// (URL-hash paste) and a leading '/' on path are tolerated.
export interface ParsedHash {
  server: string
  docname: string
  token: string
  path: string
  tags: string[]
}

export function parseHash(h: string): ParsedHash {
  const parts = h.replace(/^#\/?/, '').split(SEP)
  if (parts.length < 2) throw new Error(`Invalid hash format: ${h}`)
  const [serverRaw, docnameRaw, tokenRaw = '', pathRaw = '', tagsStr = ''] = parts
  const server = serverRaw.trim()
  const docname = docnameRaw.trim()
  if (!server || !docname) throw new Error(`Invalid hash format: ${h}`)
  const path = pathRaw.trim().replace(/^\//, '')
  const tags = tagsStr
    .split(TAGSEP)
    .map((t) => t.trim())
    .filter((t) => t)
  return { server, docname, token: tokenRaw, path, tags }
}

export interface SplitBoxPath {
  /** Map-path of the box itself under the doc root, e.g. "BOX". */
  boxPath: string
  /** Path of the file inside the box, e.g. "shop.yaml". Never empty. */
  innerPath: string
}

export function splitBoxPath(fullPath: string): SplitBoxPath {
  const steps = fullPath.split('/').filter((s) => s !== '')
  const at = steps.indexOf(BOX_MARKER)
  if (at < 0 || at === steps.length - 1) {
    throw new Error(`Not an in-box path (need "<box>/@/<file>"): ${fullPath}`)
  }
  return {
    boxPath: steps.slice(0, at).join('/'),
    innerPath: steps.slice(at + 1).join('/'),
  }
}

export function joinBoxPath(boxPath: string, innerPath: string): string {
  return `${boxPath}/${BOX_MARKER}/${innerPath}`
}
