import { Doc } from 'yjs'
import * as Y from 'yjs'

const DB_PREFIX = 'y-sweet-'
const OBJECT_STORE_NAME = 'updates'

/**
 * Maximum number of independent updates to store in IndexedDB.
 * If this is exceeded, all of the updates are compacted into one.
 */
const MAX_UPDATES_IN_STORE = 50

/** Pair of key and value stored in IndexedDB. */
interface BytesWithKey {
  key: number
  value: Uint8Array
}

function openIndexedDB(name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 4)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = reject
  })
}

export async function createIndexedDBProvider(doc: Doc, docId: string): Promise<IndexedDBProvider> {
  const db = await openIndexedDB(DB_PREFIX + docId)
  return new IndexedDBProvider(doc, docId, db)
}

export class IndexedDBProvider {
  lastUpdateKey: number = -1
  broadcastChannel: BroadcastChannel

  constructor(
    private doc: Doc,
    docId: string,
    private db: IDBDatabase,
  ) {
    this.handleUpdate = this.handleUpdate.bind(this)
    doc.on('update', this.handleUpdate)

    this.broadcastChannel = new BroadcastChannel(`y-sweet-${docId}`)

    this.broadcastChannel.onmessage = (event) => {
      if (event.data > this.lastUpdateKey) {
        this.loadFromDb()
      }
    }

    this.loadFromDb()
  }

  private updateKey() {
    this.lastUpdateKey += 1
    return this.lastUpdateKey
  }

  async loadFromDb() {
    let range = IDBKeyRange.lowerBound(this.lastUpdateKey, true)
    const updates = await this.getAllValues(range)

    this.doc.transact(() => {
      for (const update of updates) {
        Y.applyUpdate(this.doc, update.value)

        this.lastUpdateKey = update.key
      }
    }, this)
  }

  destroy() {
    this.doc.off('update', this.handleUpdate)
    this.broadcastChannel.close()
  }

  async handleUpdate(update: Uint8Array, origin: any) {
    if (origin === this) {
      return
    }

    // We attempt to write in a loop. If we are preempted by another writer, we load the latest
    // updates and try again.
    while (true) {
      await this.loadFromDb()
      let key = this.updateKey()
      let newCount = await this.insertValue(key, update)

      if (newCount === null) {
        // Another writer wrote before we could; reload and try again.
        continue
      }

      if (newCount > MAX_UPDATES_IN_STORE) {
        key = this.updateKey()
        if (!(await this.saveWholeState(key))) {
          // Another writer wrote before we could; reload and try again.
          continue
        }
      }

      break
    }

    this.broadcastChannel.postMessage(this.lastUpdateKey)
  }

  async getAllValues(range?: IDBKeyRange): Promise<Array<BytesWithKey>> {
    let transaction = this.db.transaction(OBJECT_STORE_NAME)
    let objectStore = transaction.objectStore(OBJECT_STORE_NAME)
    const request = objectStore.getAll(range)

    return await new Promise<Array<BytesWithKey>>((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = reject
    })
  }

  async saveWholeState(key: number): Promise<boolean> {
    const update = Y.encodeStateAsUpdate(this.doc)
    let transaction = this.db.transaction(OBJECT_STORE_NAME, 'readwrite')
    let objectStore = transaction.objectStore(OBJECT_STORE_NAME)

    if (await this.hasValue(objectStore, key)) {
      return false
    }

    let range = IDBKeyRange.upperBound(key, false)
    objectStore.delete(range)

    objectStore.add({
      key,
      value: update,
    })

    return true
  }

  async hasValue(objectStore: IDBObjectStore, key: number): Promise<boolean> {
    const request = objectStore.get(key)
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => resolve()
      request.onerror = reject
    })

    return request.result !== undefined
  }

  /**
   * Insert a value into IndexedDB. Return the new count of updates in the store if the value was inserted,
   * or null if the desired key already exists.
   **/
  async insertValue(key: number, value: Uint8Array): Promise<number | null> {
    let objectStore = this.db
      .transaction(OBJECT_STORE_NAME, 'readwrite')
      .objectStore(OBJECT_STORE_NAME)

    if (await this.hasValue(objectStore, key)) {
      return null
    }

    const request = objectStore.put({
      key,
      value,
    })

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => resolve()
      request.onerror = reject
    })

    let countRequest = objectStore.count()
    let count = await new Promise<number>((resolve, reject) => {
      countRequest.onsuccess = () => resolve(countRequest.result)
      countRequest.onerror = reject
    })

    return count
  }
}
