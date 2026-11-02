/**
 * store.js — ที่เก็บข้อมูลในเครื่องผู้ใช้ (ต้นแบบไม่มี backend)
 *
 * - ห้อง/แปลน: localStorage (เล็ก อ่านง่าย)
 * - ภาพถ่าย: IndexedDB (เก็บ Blob ได้ ไม่ต้องแปลงเป็น base64)
 *
 * ความเป็นส่วนตัว: ภาพภายในบ้านไม่ออกจากเครื่องในต้นแบบนี้เลย
 * และทุกห้องลบภาพได้ทันทีด้วย deleteShots() — ระบบจริงต้องมีนโยบายลบอัตโนมัติด้วย
 * (ดู docs/05-privacy-safety.md)
 */

const ROOMS_KEY = 'roomscan.rooms.v1';
const DB_NAME = 'roomscan';
const DB_VERSION = 1;

/* ======================================================================
 * ห้อง
 * ==================================================================== */
function readRooms() {
  try {
    return JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]');
  } catch (err) {
    return []; // private mode หรือข้อมูลเสีย — เริ่มใหม่ได้
  }
}

function writeRooms(rooms) {
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
    return true;
  } catch (err) {
    console.warn('บันทึกห้องไม่สำเร็จ', err);
    return false;
  }
}

export function listRooms() {
  return readRooms().sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

export function getRoom(id) {
  return readRooms().find((r) => r.id === id) || null;
}

export function saveRoom(room) {
  const rooms = readRooms();
  room.updated = new Date().toISOString();
  const i = rooms.findIndex((r) => r.id === room.id);
  if (i === -1) rooms.push(room);
  else rooms[i] = room;
  writeRooms(rooms);
  return room;
}

export function createRoom(name, project) {
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return saveRoom({ id, name: name || 'ห้องใหม่', project: project || 'บ้านของฉัน', created: new Date().toISOString(), plan: null, references: [], capture: null });
}

export async function deleteRoom(id) {
  writeRooms(readRooms().filter((r) => r.id !== id));
  await deleteShots(id);
}

/* ======================================================================
 * ภาพถ่าย (IndexedDB)
 * ==================================================================== */
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('เบราว์เซอร์นี้ไม่รองรับ IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('shots', { keyPath: 'id' });
        store.createIndex('room', 'roomId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction('shots', mode);
        const out = fn(t.objectStore('shots'));
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
      })
  );
}

export function addShot(shot) {
  return tx('readwrite', (s) => s.put(shot));
}

export function removeShot(id) {
  return tx('readwrite', (s) => s.delete(id));
}

export function listShots(roomId) {
  return tx('readonly', (s) => s.index('room').getAll(roomId)).then((rows) =>
    (rows || []).sort((a, b) => a.meta.t - b.meta.t)
  );
}

export async function deleteShots(roomId) {
  try {
    const rows = await listShots(roomId);
    await tx('readwrite', (s) => rows.forEach((r) => s.delete(r.id)));
  } catch (err) {
    console.warn('ลบภาพไม่สำเร็จ', err);
  }
}

/** ประมาณพื้นที่ที่ใช้ — ให้ผู้ใช้เห็นว่าข้อมูลอยู่ในเครื่องเท่าไร */
export async function storageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      return await navigator.storage.estimate();
    } catch (err) {
      return null;
    }
  }
  return null;
}
