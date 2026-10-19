const DB_NAME = 'stellanova-creator-drafts'
const STORE_NAME = 'drafts'

function openDraftDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local draft storage'))
  })
}

export async function saveStudioDraft<T>(key: string, draft: T) {
  const db = await openDraftDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(draft, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save draft'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Draft save was interrupted'))
  })
  db.close()
}

export async function loadStudioDraft<T>(key: string): Promise<T | null> {
  const db = await openDraftDb()
  const draft = await new Promise<T | null>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('Could not load draft'))
  })
  db.close()
  return draft
}

export async function deleteStudioDraft(key: string) {
  const db = await openDraftDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove the saved draft'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Draft removal was interrupted'))
  })
  db.close()
}
