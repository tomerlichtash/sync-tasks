import { Firestore, Timestamp } from '@google-cloud/firestore';

const db = new Firestore();

export interface SyncedItem {
  icloudUid: string;
  googleTaskId: string;
  title: string;
  syncedAt: Timestamp;
  lastModified: Timestamp;
  completed: boolean;
}

const COLLECTION_NAME = 'synced-reminders';

function getCollection() {
  return db.collection(COLLECTION_NAME);
}

export async function getSyncedItem(icloudUid: string): Promise<SyncedItem | null> {
  const doc = await getCollection().doc(icloudUid).get();
  if (!doc.exists) {
    return null;
  }
  return doc.data() as SyncedItem;
}

export async function getAllSyncedItems(): Promise<Map<string, SyncedItem>> {
  const snapshot = await getCollection().get();
  const items = new Map<string, SyncedItem>();

  snapshot.forEach((doc) => {
    items.set(doc.id, doc.data() as SyncedItem);
  });

  return items;
}

export async function saveSyncedItem(item: SyncedItem): Promise<void> {
  await getCollection().doc(item.icloudUid).set({
    ...item,
    syncedAt: Timestamp.now(),
  });
}

export async function updateSyncedItem(
  icloudUid: string,
  updates: Partial<SyncedItem>
): Promise<void> {
  await getCollection().doc(icloudUid).update({
    ...updates,
    lastModified: Timestamp.now(),
  });
}

export async function deleteSyncedItem(icloudUid: string): Promise<void> {
  await getCollection().doc(icloudUid).delete();
}
