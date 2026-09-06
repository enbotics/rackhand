import { isScanResult } from "@/lib/warehouse/scan-result";
import type { MeasurementResult, ScanResult } from "@/lib/warehouse/scan-types";

/**
 * The measured fields come from the shared `/api/measure` contract
 * (lib/warehouse/scan-types.ts) so client and server cannot drift apart;
 * `measuredAt` is the only piece this local record adds.
 *
 * `calibrationRmsPixels` is the reprojection RMS from the mat's 4-QR
 * homography fit — how trustworthy the mm conversion for this shot was, not
 * a confidence in the object itself.
 */
export type Measurement = MeasurementResult & {
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
  /** Warehouse scan contract for this shot. Absent on shots taken before it existed, and on shots that were never measured. */
  scanResult?: ScanResult;
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

/**
 * Stored records predate `scanResult` and are not revalidated on write by
 * IndexedDB, so a persisted scan is only trusted if it still satisfies the
 * contract — anything else loads as a shot without one rather than
 * crashing the gallery.
 */
function fromStored(record: Shot): Shot {
  if (record.scanResult === undefined || isScanResult(record.scanResult)) return record;
  return { ...record, scanResult: undefined };
}

export async function getAllShots(): Promise<Shot[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const shots = (req.result as Shot[])
        .map(fromStored)
        .sort((a, b) => b.createdAt - a.createdAt);
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

/** `scanResult` is optional so a measurement that failed ScanResult validation still persists its measurement. */
export async function setShotMeasurement(
  id: string,
  measurement: Measurement,
  scanResult?: ScanResult,
): Promise<void> {
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
      // `scanResult` overwrites unconditionally: a re-measure that fails
      // ScanResult validation must not leave the previous scan attached.
      store.put({ ...shot, measurement, scanResult });
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
