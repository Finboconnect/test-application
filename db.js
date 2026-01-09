const DB_NAME = "kanbanDB";
const DB_VERSION = 2;

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txToPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("boards")) {
        db.createObjectStore("boards", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("tasks")) {
        const tasks = db.createObjectStore("tasks", { keyPath: "id" });
        tasks.createIndex("boardId", "boardId", { unique: false });
        tasks.createIndex("boardId_status", ["boardId", "status"], {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains("events")) {
        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("boardId", "boardId", { unique: false });
        events.createIndex("boardId_ts", ["boardId", "ts"], { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

export async function initDB() {
  await openDB();
}

export function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

export async function getBoards() {
  const db = await openDB();
  const tx = db.transaction(["boards"], "readonly");
  const store = tx.objectStore("boards");
  const boards = await requestToPromise(store.getAll());
  await txToPromise(tx);
  return boards;
}

export async function getBoard(id) {
  const db = await openDB();
  const tx = db.transaction(["boards"], "readonly");
  const board = await requestToPromise(tx.objectStore("boards").get(id));
  await txToPromise(tx);
  return board || null;
}

export async function saveBoard(board) {
  const db = await openDB();
  const tx = db.transaction(["boards"], "readwrite");
  await requestToPromise(tx.objectStore("boards").put(board));
  await txToPromise(tx);
  return board;
}

async function deleteTasksByBoardIdInTx(tx, boardId) {
  const store = tx.objectStore("tasks");
  const index = store.index("boardId");
  const range = IDBKeyRange.only(boardId);

  return new Promise((resolve, reject) => {
    const cursorRequest = index.openCursor(range);
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return resolve();
      cursor.delete();
      cursor.continue();
    };
  });
}

export async function deleteBoard(boardId) {
  const db = await openDB();
  const tx = db.transaction(["boards", "tasks"], "readwrite");
  await requestToPromise(tx.objectStore("boards").delete(boardId));
  await deleteTasksByBoardIdInTx(tx, boardId);
  await txToPromise(tx);
}

export async function deleteTasksByBoardId(boardId) {
  const db = await openDB();
  const tx = db.transaction(["tasks"], "readwrite");
  await deleteTasksByBoardIdInTx(tx, boardId);
  await txToPromise(tx);
}

export async function getTasks(boardId) {
  const db = await openDB();
  const tx = db.transaction(["tasks"], "readonly");
  const store = tx.objectStore("tasks");
  const index = store.index("boardId");
  const tasks = await requestToPromise(index.getAll(IDBKeyRange.only(boardId)));
  await txToPromise(tx);
  return tasks;
}

export async function saveTask(task) {
  const db = await openDB();
  const tx = db.transaction(["tasks"], "readwrite");
  await requestToPromise(tx.objectStore("tasks").put(task));
  await txToPromise(tx);
  return task;
}

export async function saveTasks(tasks) {
  if (!tasks.length) return;
  const db = await openDB();
  const tx = db.transaction(["tasks"], "readwrite");
  const store = tx.objectStore("tasks");
  for (const task of tasks) {
    store.put(task);
  }
  await txToPromise(tx);
}

export async function deleteTask(taskId) {
  const db = await openDB();
  const tx = db.transaction(["tasks"], "readwrite");
  await requestToPromise(tx.objectStore("tasks").delete(taskId));
  await txToPromise(tx);
}

export async function getSetting(key) {
  const db = await openDB();
  const tx = db.transaction(["settings"], "readonly");
  const row = await requestToPromise(tx.objectStore("settings").get(key));
  await txToPromise(tx);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  const db = await openDB();
  const tx = db.transaction(["settings"], "readwrite");
  await requestToPromise(tx.objectStore("settings").put({ key, value }));
  await txToPromise(tx);
  return value;
}

export async function addEvent(event) {
  const db = await openDB();
  const tx = db.transaction(["events"], "readwrite");
  await requestToPromise(tx.objectStore("events").put(event));
  await txToPromise(tx);
  return event;
}

export async function getEvents(boardId, { limit = 200 } = {}) {
  const db = await openDB();
  const tx = db.transaction(["events"], "readonly");
  const store = tx.objectStore("events");

  let rows = [];
  if (boardId) {
    const index = store.index("boardId");
    rows = await requestToPromise(index.getAll(IDBKeyRange.only(boardId)));
  } else {
    rows = await requestToPromise(store.getAll());
  }
  await txToPromise(tx);
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return rows.slice(0, Math.max(1, limit));
}
