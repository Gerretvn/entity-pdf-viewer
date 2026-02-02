import { openDB, DBSchema } from 'idb';

interface EntityDB extends DBSchema {
  matches: {
    key: number;
    value: {
      entity: string;
      fileName: string;
      pageNumber: number;
      textSnippet: string;
      fileHandle: FileSystemFileHandle;
      timestamp: number;
    };
    indexes: { 'by-entity': string };
  };
}

const DB_NAME = 'entity-viewer-db';
const STORE_NAME = 'matches';

export const initDB = async () => {
  return openDB<EntityDB>(DB_NAME, 1, {
    upgrade(db) {
      const store = db.createObjectStore(STORE_NAME, {
        keyPath: 'id',
        autoIncrement: true,
      });
      store.createIndex('by-entity', 'entity');
    },
  });
};

export const addMatch = async (match: any) => {
  const db = await initDB();
  await db.add(STORE_NAME, match);
};

export const clearMatches = async () => {
  const db = await initDB();
  await db.clear(STORE_NAME);
};

export const getMatchesForEntity = async (entity: string) => {
  const db = await initDB();
  return db.getAllFromIndex(STORE_NAME, 'by-entity', entity);
};

export const getAllEntitiesGrouped = async () => {
  const db = await initDB();
  const allMatches = await db.getAll(STORE_NAME);
  
  const counts: Record<string, number> = {};
  allMatches.forEach((m) => {
    counts[m.entity] = (counts[m.entity] || 0) + 1;
  });
  
  return counts;
};