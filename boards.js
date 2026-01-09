import { getBoards, getSetting, makeId, saveBoard, setSetting, deleteBoard } from "./db.js?v=2026-01-09-1";

export const COLUMN_IDS = ["todo", "inprogress", "review", "test", "done"];

export const COLUMN_LABELS = {
  todo: "To Do",
  inprogress: "In Progress",
  review: "Review",
  test: "Test",
  done: "Done",
};

const ACTIVE_BOARD_KEY = "activeBoardId";

function nowISO() {
  return new Date().toISOString();
}

export function makeBoard(name) {
  const timestamp = nowISO();
  return {
    id: makeId(),
    name: (name || "My Board").trim() || "My Board",
    columns: [...COLUMN_IDS],
    wipLimits: Object.fromEntries(COLUMN_IDS.map((c) => [c, null])),
    columnPolicies: Object.fromEntries(COLUMN_IDS.map((c) => [c, ""])),
    groupBy: "none",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function ensureDefaultBoard() {
  const boards = await getBoards();
  if (boards.length) return boards;

  const board = makeBoard("My Board");
  await saveBoard(board);
  await setActiveBoardId(board.id);
  return [board];
}

export async function getActiveBoardId() {
  return (await getSetting(ACTIVE_BOARD_KEY)) || null;
}

export async function setActiveBoardId(boardId) {
  await setSetting(ACTIVE_BOARD_KEY, boardId);
  return boardId;
}

export async function createBoard(name) {
  const board = makeBoard(name);
  await saveBoard(board);
  await setActiveBoardId(board.id);
  return board;
}

export async function renameBoard(boardId, name) {
  const boards = await getBoards();
  const board = boards.find((b) => b.id === boardId);
  if (!board) throw new Error("Board not found");
  board.name = (name || "").trim() || board.name;
  board.updatedAt = nowISO();
  await saveBoard(board);
  return board;
}

export async function updateBoardSettings(boardId, { wipLimits, columnPolicies, groupBy }) {
  const boards = await getBoards();
  const board = boards.find((b) => b.id === boardId);
  if (!board) throw new Error("Board not found");

  if (wipLimits && typeof wipLimits === "object") board.wipLimits = wipLimits;
  if (columnPolicies && typeof columnPolicies === "object") board.columnPolicies = columnPolicies;
  if (groupBy) board.groupBy = groupBy;

  board.updatedAt = nowISO();
  await saveBoard(board);
  return board;
}

export async function removeBoard(boardId) {
  await deleteBoard(boardId);
  const boards = await getBoards();
  if (boards.length) {
    const active = await getActiveBoardId();
    if (active === boardId) await setActiveBoardId(boards[0].id);
    return boards;
  }
  const created = await createBoard("My Board");
  return [created];
}
