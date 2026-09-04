export type Measurement = {
  name: string;
  description: string;
  lengthMM: number;
  widthMM: number;
  heightMM: number | null;
  angleDegrees: number;
  dimensionConfidence: number;
  /** Reprojection RMS (pixels) from the mat's 4-QR homography fit — how trustworthy the mm conversion for this shot was, not a confidence in the object itself. */
  calibrationRmsPixels: number;
  measuredAt: number;
};

export type Shot = {
  id: string;
  dataUrl: string;
  createdAt: number;
  width: number;
  height: number;
  deviceLabel: string | null;
  measurement?: Measurement;
};

const DB_NAME = "safelight";
const DB_VERSION = 1;
const STORE = "shots";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllShots(): Promise<Shot[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const shots = (req.result as Shot[]).sort(
        (a, b) => b.createdAt - a.createdAt
      );
      resolve(shots);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function addShot(shot: Shot): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(shot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function setShotMeasurement(id: string, measurement: Measurement): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const shot = getReq.result as Shot | undefined;
      if (!shot) {
        reject(new Error(`No shot with id "${id}"`));
        return;
      }
      store.put({ ...shot, measurement });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteShot(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
