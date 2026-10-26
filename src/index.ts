// Public API of yjs-boxtools: a lean virtual-filesystem-in-Yjs toolkit.
//
//   paths  config + path grammars ("server::doc::tok::path::tags", "BOX/@/f")
//   vfs    file operations on a box map (text + binary)
//   box    doc-level entry points (plain map paths and /@/ full paths)
//   setup  provider setup + readiness gate + config parsing

export { SEP, TAGSEP, BOX_MARKER, ROOT_ID, splitBoxPath, joinBoxPath, stripInBoxSuffix, inBoxPath, parseHash } from './paths'
export type { SplitBoxPath, ParsedHash } from './paths'
export { createVfs } from './vfs'
export type { Vfs } from './vfs'
export { openMap, openVfs, openBox, getFileText, listBoxFiles } from './box'
export { watchBox, watchFile, pathOfId } from './watch'
export type { BoxEvent, BoxEventType } from './watch'
export { parseConfig, setupYjs, checkMoved } from './setup'
export type { BoxConfig, ConnectionOptions, Connection } from './setup'
