import type { RtsMapDoc } from '@battlebadger/sim'

// Local map library in IndexedDB (shared by the lobby and the editor).
// Library entries are keyed `lib:<name>`; the editor autosave uses its own key.

const DB_NAME = 'battlebadger-editor'
const STORE = 'maps'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error as Error)
  })
}

export async function idbPut(key: string, value: string): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error as Error)
  })
}

export async function idbGet(key: string): Promise<string | null> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as string) ?? null)
    req.onerror = () => reject(req.error as Error)
  })
}

export async function idbDelete(key: string): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error as Error)
  })
}

/** Every key under a prefix, sorted. The store is shared by prefix — maps use
 * 'lib:', the ruleset shelf uses 'rules:' — so one database opens, not two. */
export async function idbKeys(prefix: string): Promise<string[]> {
  const db = await open()
  const keys = await new Promise<string[]>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys()
    req.onsuccess = () => resolve((req.result as string[]).filter((k) => k.startsWith(prefix)))
    req.onerror = () => reject(req.error as Error)
  })
  return keys.sort()
}

export interface LibraryEntry {
  key: string
  name: string
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  return (await idbKeys('lib:')).map((key) => ({ key, name: key.slice(4) }))
}

export async function saveToLibrary(doc: RtsMapDoc, json?: string): Promise<string> {
  const key = `lib:${doc.name || 'untitled-map'}`
  await idbPut(key, json ?? JSON.stringify(doc))
  return key
}

export async function loadLibraryMap(key: string): Promise<{ doc: RtsMapDoc; json: string } | null> {
  const json = await idbGet(key)
  if (!json) return null
  try {
    const doc = JSON.parse(json) as RtsMapDoc
    if (!doc.cols || !doc.rows || !doc.startLocations) return null
    return { doc, json }
  } catch {
    return null
  }
}
