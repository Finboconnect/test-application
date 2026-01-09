import {
  addEvent,
  deleteTask,
  deleteTasksByBoardId,
  getBoards,
  getEpics,
  getEvents,
  getSprints,
  getSprintSnapshots,
  getTasks,
  initDB,
  makeId,
  saveEpic,
  saveSprint,
  saveTask,
  saveTasks,
  deleteEpic,
  deleteSprint,
  upsertSprintSnapshot,
} from "./db.js?v=2026-01-09-5";
import {
  COLUMN_IDS,
  COLUMN_LABELS,
  createBoard,
  ensureDefaultBoard,
  getActiveBoardId,
  removeBoard,
  renameBoard,
  setActiveBoardId,
  updateBoardSettings,
} from "./boards.js?v=2026-01-09-5";
import { initTheme, toggleTheme } from "./theme.js?v=2026-01-09-5";

const state = {
  boards: [],
  activeBoardId: null,
  activeBoard: null,
  viewMode: "kanban",
  tasks: [],
  tasksById: new Map(),
  epics: [],
  epicsById: new Map(),
  sprints: [],
  sprintsById: new Map(),
  activeSprintId: null,
  draggingEl: null,
  filter: { search: "", priority: "", groupBy: "none" },
  bulk: { enabled: false, selected: new Set() },
  modal: { openId: null, dirty: false, preview: false, focusTrapCleanup: null },
  undo: null,
  swRegistration: null,
  updateRequested: false,
};

function nowISO() {
  return new Date().toISOString();
}

const APP_VERSION = "2026-01-09-5";

function parseLabels(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  return String(input)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function ensureBoardDefaults(board) {
  const b = { ...board };
  b.wipLimits = b.wipLimits && typeof b.wipLimits === "object" ? b.wipLimits : {};
  b.columnPolicies = b.columnPolicies && typeof b.columnPolicies === "object" ? b.columnPolicies : {};
  for (const c of COLUMN_IDS) {
    if (!(c in b.wipLimits)) b.wipLimits[c] = null;
    if (!(c in b.columnPolicies)) b.columnPolicies[c] = "";
  }
  b.groupBy = b.groupBy || "none";
  b.viewMode = b.viewMode === "scrum" ? "scrum" : "kanban";
  b.activeSprintId = b.activeSprintId || null;
  return b;
}

function wipLimitFor(status) {
  const limit = state.activeBoard?.wipLimits?.[status];
  if (limit == null || limit === "") return null;
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function canPlaceInStatus(status, { excludingTaskId = null } = {}) {
  const limit = wipLimitFor(status);
  if (!limit) return true;
  const count = state.tasks.filter((t) => {
    if (t.status !== status) return false;
    if (t.id === excludingTaskId) return false;
    if (state.viewMode === "scrum") {
      if (!state.activeSprintId) return false;
      if (t.sprintId !== state.activeSprintId) return false;
    }
    return true;
  }).length;
  return count < limit;
}

async function logEvent(type, payload) {
  try {
    await addEvent({
      id: makeId(),
      boardId: state.activeBoardId,
      type,
      ts: nowISO(),
      v: APP_VERSION,
      payload: payload || {},
    });
  } catch {
    // ignore
  }
}

function byOrderThenDate(a, b) {
  const ao = typeof a.order === "number" ? a.order : 0;
  const bo = typeof b.order === "number" ? b.order : 0;
  if (ao !== bo) return ao - bo;
  return String(a.updatedAt || "").localeCompare(String(b.updatedAt || ""));
}

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node;
}

function escapeText(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function showToast(message, { kind = "info", actions = [], timeoutMs = 4500 } = {}) {
  const root = document.getElementById("toastRoot");
  if (!root) return;

  const toast = document.createElement("div");
  toast.className = "toast";

  const row = document.createElement("div");
  row.className = "toast-row";
  const text = document.createElement("div");
  text.textContent = message;
  text.style.fontWeight = kind === "error" ? "800" : "700";
  row.appendChild(text);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-icon";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", () => toast.remove());
  row.appendChild(closeBtn);
  toast.appendChild(row);

  if (actions.length) {
    const arow = document.createElement("div");
    arow.className = "toast-actions";
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = action.kind === "danger" ? "btn btn-danger" : "btn";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        try {
          action.onClick?.();
        } finally {
          toast.remove();
        }
      });
      arow.appendChild(btn);
    }
    toast.appendChild(arow);
  }

  root.appendChild(toast);
  setTimeout(() => toast.remove(), Math.max(800, timeoutMs));
}

function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function taskCounts(tasks) {
  const counts = Object.fromEntries(COLUMN_IDS.map((id) => [id, 0]));
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
}

function filteredTasks() {
  const q = state.filter.search.trim().toLowerCase();
  const pf = state.filter.priority;
  return state.tasks.filter((t) => {
    if (pf === "high" || pf === "medium" || pf === "low") {
      if (t.priority !== pf) return false;
    } else if (pf === "none") {
      if ((t.priority || "") !== "") return false;
    }
    if (!q) return true;
    const hay = [
      t.title,
      t.description,
      t.assignee,
      Array.isArray(t.labels) ? t.labels.join(" ") : "",
      Array.isArray(t.attachments) ? t.attachments.join(" ") : "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function groupKeyForTask(task) {
  const groupBy = state.filter.groupBy || "none";
  if (groupBy === "priority") return task.priority || "none";
  if (groupBy === "label") return (task.labels && task.labels[0]) || "none";
  return "all";
}

function groupLabelForKey(key) {
  if (state.filter.groupBy === "priority") {
    return key === "high" ? "High" : key === "medium" ? "Medium" : key === "low" ? "Low" : "None";
  }
  if (state.filter.groupBy === "label") return key === "none" ? "No label" : key;
  return "";
}

function groupOrderKeys(keys) {
  if (state.filter.groupBy === "priority") {
    const order = ["high", "medium", "low", "none"];
    return [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  return [...keys].sort((a, b) => String(a).localeCompare(String(b)));
}

function statusIndex(status) {
  return Math.max(0, COLUMN_IDS.indexOf(status));
}

function prevStatus(status) {
  const idx = statusIndex(status);
  return COLUMN_IDS[Math.max(0, idx - 1)];
}

function nextStatus(status) {
  const idx = statusIndex(status);
  return COLUMN_IDS[Math.min(COLUMN_IDS.length - 1, idx + 1)];
}

function normalizeTask(task) {
  const normalized = { ...task };
  if (!COLUMN_IDS.includes(normalized.status)) normalized.status = "todo";
  if (typeof normalized.order !== "number") normalized.order = 0;
  normalized.title = (normalized.title || "").trim();
  normalized.description = normalized.description || "";
  normalized.priority = normalized.priority || "";
  normalized.color = normalized.color || "#4f46e5";
  normalized.assignee = normalized.assignee || "";
  normalized.epicId = normalized.epicId || "";
  normalized.sprintId = normalized.sprintId || "";
  normalized.dueDate = normalized.dueDate || "";
  normalized.labels = Array.isArray(normalized.labels) ? normalized.labels : parseLabels(normalized.labels);
  normalized.blocked = Boolean(normalized.blocked);
  normalized.checklist = Array.isArray(normalized.checklist) ? normalized.checklist : [];
  normalized.attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
  normalized.doneAt = normalized.doneAt || "";
  return normalized;
}

async function loadBoardsAndActive() {
  await ensureDefaultBoard();
  state.boards = (await getBoards()).map(ensureBoardDefaults);
  state.activeBoardId = (await getActiveBoardId()) || state.boards[0]?.id || null;
  if (state.activeBoardId) await setActiveBoardId(state.activeBoardId);
  state.activeBoard = state.boards.find((b) => b.id === state.activeBoardId) || null;
  if (state.activeBoard) state.filter.groupBy = state.activeBoard.groupBy || "none";
  state.viewMode = state.activeBoard?.viewMode || "kanban";
  state.activeSprintId = state.activeBoard?.activeSprintId || null;
}

async function loadTasks() {
  const loaded = (await getTasks(state.activeBoardId)).map(normalizeTask);

  const migrated = [];
  for (const t of loaded) {
    if (!t.sprintId && typeof t.inSprint === "boolean" && state.activeSprintId) {
      const copy = { ...t, sprintId: t.inSprint ? state.activeSprintId : "" };
      delete copy.inSprint;
      migrated.push(copy);
    } else if (typeof t.inSprint === "boolean") {
      const copy = { ...t };
      delete copy.inSprint;
      migrated.push(copy);
    }
  }
  if (migrated.length) {
    try {
      await saveTasks(migrated);
      for (const t of migrated) {
        const idx = loaded.findIndex((x) => x.id === t.id);
        if (idx >= 0) loaded[idx] = normalizeTask(t);
      }
    } catch {
      // ignore migration errors
    }
  }

  state.tasks = loaded.sort(byOrderThenDate);
  state.tasksById = new Map(state.tasks.map((t) => [t.id, t]));
}

async function loadEpics() {
  state.epics = (await getEpics(state.activeBoardId)).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || "")),
  );
  state.epicsById = new Map(state.epics.map((e) => [e.id, e]));
}

async function loadSprints() {
  const sprints = await getSprints(state.activeBoardId);
  sprints.sort((a, b) => {
    const order = { active: 0, planned: 1, completed: 2 };
    const ao = order[a.status] ?? 9;
    const bo = order[b.status] ?? 9;
    if (ao !== bo) return ao - bo;
    return String(a.endDate || a.startDate || "").localeCompare(String(b.endDate || b.startDate || ""));
  });
  state.sprints = sprints;
  state.sprintsById = new Map(state.sprints.map((s) => [s.id, s]));
}

function renderBoardSelect() {
  const select = el("boardSelect");
  select.innerHTML = state.boards
    .map(
      (b) =>
        `<option value="${escapeText(b.id)}" ${
          b.id === state.activeBoardId ? "selected" : ""
        }>${escapeText(b.name)}</option>`,
    )
    .join("");
}

function renderColumns() {
  const scrumView = document.getElementById("scrumView");
  const kanbanView = document.getElementById("kanbanView");
  if (state.viewMode === "scrum") {
    if (scrumView) scrumView.hidden = false;
    if (kanbanView) kanbanView.hidden = true;
    renderScrum();
    return;
  }
  if (scrumView) scrumView.hidden = true;
  if (kanbanView) kanbanView.hidden = false;

  const columnsRoot = el("columns");
  const tasks = filteredTasks();
  const counts = taskCounts(tasks);

  const columnsHtml = COLUMN_IDS.map((status) => {
    const label = COLUMN_LABELS[status] || status;
    const limit = wipLimitFor(status);
    const limitLabel = limit ? ` / ${limit}` : "";
    const policy = (state.activeBoard?.columnPolicies?.[status] || "").trim();
    const addButton =
      status === "todo"
        ? `
          <button class="btn btn-icon add-task-btn" type="button" data-status="${escapeText(
            status,
          )}" aria-label="Add task">
            <span aria-hidden="true">+</span>
          </button>
        `
        : "";
    const policyBtn = policy
      ? `<button class="mini-btn policy-btn" type="button" data-status="${escapeText(
          status,
        )}" aria-label="View column policy">i</button>`
      : "";
    return `
      <section class="column" data-status="${escapeText(status)}" aria-label="${escapeText(label)} column">
        <div class="column-header">
          <div style="display:flex; gap:10px; align-items:center; min-width:0;">
            <div class="column-title">${escapeText(label)}</div>
            <div class="count-pill" aria-label="Task count">${counts[status] || 0}${escapeText(
              limitLabel,
            )}</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${policyBtn}
            ${addButton}
          </div>
        </div>
        <div class="task-list" role="list" data-root="columns" data-status="${escapeText(status)}"></div>
      </section>
    `;
  }).join("");

  columnsRoot.innerHTML = columnsHtml;

  for (const status of COLUMN_IDS) {
    const list = columnsRoot.querySelector(`.task-list[data-status="${CSS.escape(status)}"]`);
    if (!list) continue;
    list.addEventListener("dragover", onDragOver);
    list.addEventListener("drop", onDrop);
    list.addEventListener("dragenter", (e) => {
      if (state.filter.groupBy !== "none" || state.bulk.enabled) return;
      e.preventDefault();
      list.style.outline = `2px dashed color-mix(in srgb, var(--accent) 55%, transparent)`;
      list.style.outlineOffset = "4px";
    });
    list.addEventListener("dragleave", () => {
      list.style.outline = "";
      list.style.outlineOffset = "";
    });
  }

  columnsRoot.querySelectorAll(".policy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const status = btn.dataset.status;
      const policy = (state.activeBoard?.columnPolicies?.[status] || "").trim();
      showToast(policy || "No policy set.", { timeoutMs: 7000 });
    });
  });

  renderTasks();
}

function render() {
  renderColumns();
}

function formatSprintRange(sprint) {
  const sd = sprint?.startDate ? String(sprint.startDate) : "";
  const ed = sprint?.endDate ? String(sprint.endDate) : "";
  if (sd && ed) return `${sd} to ${ed}`;
  if (sd) return `Starts ${sd}`;
  if (ed) return `Ends ${ed}`;
  return "";
}

function getActiveSprint() {
  if (!state.activeSprintId) return null;
  return state.sprintsById.get(state.activeSprintId) || null;
}

function renderSprintSelectOptions(selectEl, selectedId) {
  if (!selectEl) return;
  const opts = [`<option value="">(none)</option>`].concat(
    state.sprints.map((s) => {
      const tag = s.status === "active" ? " [active]" : s.status === "completed" ? " [done]" : "";
      return `<option value="${escapeText(s.id)}">${escapeText(s.name || "Sprint")}${escapeText(tag)}</option>`;
    }),
  );
  selectEl.innerHTML = opts.join("");
  if (selectedId) selectEl.value = selectedId;
}

function renderScrumControls() {
  const select = document.getElementById("activeSprintSelect");
  const active = getActiveSprint();
  const selected = select?.value || active?.id || (state.sprints.find((s) => s.status === "planned")?.id || "");
  renderSprintSelectOptions(select, selected);

  const meta = document.getElementById("activeSprintMeta");
  if (meta) meta.textContent = active ? `${active.name} - ${formatSprintRange(active)}` : "No active sprint";

  const startBtn = document.getElementById("startSprintBtn");
  const completeBtn = document.getElementById("completeSprintBtn");
  const reportBtn = document.getElementById("sprintReportBtn");

  const selectedSprint = state.sprintsById.get(select?.value || "") || null;
  if (startBtn) startBtn.disabled = Boolean(active) || !selectedSprint || selectedSprint.status !== "planned";
  if (completeBtn) completeBtn.disabled = !active;
  if (reportBtn) reportBtn.disabled = !selectedSprint;
}

function renderTaskRow(task, { actionLabel = null, action = null, actionSprintId = "" } = {}) {
  const color = task.color || "#0052cc";
  const badges = [];
  if (task.assignee) badges.push(`<span class="badge">Assigned: ${escapeText(task.assignee)}</span>`);
  if (task.epicId && state.epicsById.has(task.epicId)) {
    badges.push(`<span class="badge">Epic: ${escapeText(state.epicsById.get(task.epicId).name || "Epic")}</span>`);
  }
  if (task.priority) badges.push(`<span class="badge ${escapeText(task.priority)}">${escapeText(task.priority)}</span>`);
  if (task.blocked) badges.push(`<span class="badge high">blocked</span>`);

  const actionBtn =
    action && actionLabel
      ? `<button class="mini-btn" type="button" data-action="${escapeText(action)}" data-task-id="${escapeText(
          task.id,
        )}" data-sprint-id="${escapeText(actionSprintId)}">${escapeText(actionLabel)}</button>`
      : "";

  return `
    <article class="task-card backlog" role="listitem" tabindex="0" draggable="true" data-task-id="${escapeText(
      task.id,
    )}">
      <div class="task-actions">${actionBtn}</div>
      <div class="task-title">
        <span class="task-color" style="background:${escapeText(color)}" aria-hidden="true"></span>
        <span>${escapeText(task.title || "Untitled task")}</span>
      </div>
      <div class="task-meta">
        ${badges.join("")}
        <span class="badge">${escapeText(COLUMN_LABELS[task.status] || task.status)}</span>
        <span class="badge">Updated: ${escapeText(shortDate(task.updatedAt))}</span>
      </div>
    </article>
  `;
}

function renderScrum() {
  renderScrumControls();
  renderScrumSprintBoard();
  renderScrumBacklog();
}

function renderScrumSprintBoard() {
  const root = document.getElementById("sprintColumns");
  if (!root) return;
  const active = getActiveSprint();

  const all = filteredTasks();
  const sprintTasks = active ? all.filter((t) => t.sprintId === active.id) : [];
  const counts = taskCounts(sprintTasks);

  root.innerHTML = COLUMN_IDS.map((status) => {
    const label = COLUMN_LABELS[status] || status;
    const limit = wipLimitFor(status);
    const limitLabel = limit ? ` / ${limit}` : "";
    const addButton =
      status === "todo" && active
        ? `
          <button class="btn btn-icon add-task-btn" type="button" data-status="todo" data-sprint-id="${escapeText(
            active.id,
          )}" aria-label="Add issue to sprint">
            <span aria-hidden="true">+</span>
          </button>
        `
        : "";
    return `
      <section class="column" data-status="${escapeText(status)}" aria-label="${escapeText(label)} column">
        <div class="column-header">
          <div style="display:flex; gap:10px; align-items:center; min-width:0;">
            <div class="column-title">${escapeText(label)}</div>
            <div class="count-pill" aria-label="Task count">${counts[status] || 0}${escapeText(limitLabel)}</div>
          </div>
          ${addButton}
        </div>
        <div class="task-list" role="list" data-root="sprintColumns" data-status="${escapeText(status)}"></div>
      </section>
    `;
  }).join("");

  for (const status of COLUMN_IDS) {
    const list = root.querySelector(`.task-list[data-status="${CSS.escape(status)}"]`);
    if (!list) continue;
    list.addEventListener("dragover", onDragOver);
    list.addEventListener("drop", onDrop);
    list.addEventListener("dragenter", (e) => {
      if (state.filter.groupBy !== "none" || state.bulk.enabled) return;
      e.preventDefault();
      list.style.outline = `2px dashed color-mix(in srgb, var(--accent) 55%, transparent)`;
      list.style.outlineOffset = "4px";
    });
    list.addEventListener("dragleave", () => {
      list.style.outline = "";
      list.style.outlineOffset = "";
    });
  }

  for (const status of COLUMN_IDS) {
    const list = root.querySelector(`.task-list[data-status="${CSS.escape(status)}"]`);
    if (!list) continue;
    list.innerHTML = sprintTasks.filter((t) => t.status === status).sort(byOrderThenDate).map(renderTaskCard).join("");
  }

  root.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.taskId;
      const task = state.tasksById.get(id);
      if (!task) return;
      openTaskModal({ mode: "edit", task });
    });
    card.addEventListener("keydown", (e) => onCardKeyDown(e, card));
    card.addEventListener("dragstart", onDragStart);
    card.addEventListener("dragend", onDragEnd);
    card.querySelectorAll(".mini-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = card.dataset.taskId;
        const task = state.tasksById.get(id);
        if (!task) return;
        const dir = btn.dataset.dir;
        const target = dir === "left" ? prevStatus(task.status) : nextStatus(task.status);
        await moveTask(id, target, { source: "quick" });
      });
    });
  });
}

function renderScrumBacklog() {
  const plannedRoot = document.getElementById("plannedSprints");
  const backlogRoot = document.getElementById("backlogList");
  if (!plannedRoot || !backlogRoot) return;

  const active = getActiveSprint();
  const all = filteredTasks();
  const backlog = all.filter((t) => !t.sprintId).sort(byOrderThenDate);
  const planned = state.sprints.filter((s) => s.status === "planned");

  plannedRoot.innerHTML = planned
    .map((s) => {
      const tasks = all.filter((t) => t.sprintId === s.id).sort(byOrderThenDate);
      const count = tasks.length;
      const startDisabled = Boolean(active);
      const actions = `
        <div class="inline">
          <button class="btn btn-primary" type="button" data-action="start-sprint" data-sprint-id="${escapeText(
            s.id,
          )}" ${startDisabled ? "disabled" : ""}>Start</button>
          <button class="btn btn-danger" type="button" data-action="delete-sprint" data-sprint-id="${escapeText(
            s.id,
          )}">Delete</button>
        </div>
      `;
      return `
        <div class="planned-sprint" data-sprint-id="${escapeText(s.id)}">
          <div class="planned-header">
            <div style="display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;">
              <div class="planned-name">${escapeText(s.name || "Sprint")}</div>
              <div class="muted" style="font-size:12px;">${escapeText(formatSprintRange(s))}</div>
              <span class="badge">${count} issues</span>
            </div>
            ${actions}
          </div>
          <div class="planned-body" role="list">
            ${tasks
              .map((t) => renderTaskRow(t, { action: "remove-from-sprint", actionLabel: "Remove", actionSprintId: s.id }))
              .join("") || `<div class="muted" style="font-size:13px;">No issues in this sprint yet.</div>`}
          </div>
        </div>
      `;
    })
    .join("");

  backlogRoot.innerHTML = backlog
    .map((t) =>
      renderTaskRow(t, {
        action: "add-to-sprint",
        actionLabel: "Add",
        actionSprintId: "",
      }),
    )
    .join("");

  // Delegated actions for backlog/planned sprints
  const onClick = async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const sprintId = btn.dataset.sprintId || "";
    const taskId = btn.dataset.taskId || "";

    if (action === "add-to-sprint") {
      const targetSprintId = sprintId || document.getElementById("activeSprintSelect")?.value || "";
      await addTaskToSprint(taskId, targetSprintId);
    } else if (action === "remove-from-sprint") {
      await removeTaskFromSprint(taskId);
    } else if (action === "start-sprint") {
      await startSprint(sprintId);
    } else if (action === "delete-sprint") {
      await deletePlannedSprint(sprintId);
    }
  };

  plannedRoot.onclick = onClick;
  backlogRoot.onclick = onClick;

  // Open task modal on card click (not on button)
  plannedRoot.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      const id = card.dataset.taskId;
      const task = state.tasksById.get(id);
      if (task) openTaskModal({ mode: "edit", task });
    });
    card.addEventListener("keydown", (e) => onCardKeyDown(e, card));
    card.addEventListener("dragstart", onDragStart);
    card.addEventListener("dragend", onDragEnd);
  });
  backlogRoot.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      const id = card.dataset.taskId;
      const task = state.tasksById.get(id);
      if (task) openTaskModal({ mode: "edit", task });
    });
    card.addEventListener("keydown", (e) => onCardKeyDown(e, card));
    card.addEventListener("dragstart", onDragStart);
    card.addEventListener("dragend", onDragEnd);
  });

  // Drop zones (scrum planning)
  const zones = [backlogRoot].concat(
    [...plannedRoot.querySelectorAll(".planned-body")].filter(Boolean),
  );
  zones.forEach((zone) => {
    zone.addEventListener("dragover", onDragOver);
    zone.addEventListener("drop", onDrop);
    zone.addEventListener("dragenter", (e) => {
      if (state.filter.groupBy !== "none" || state.bulk.enabled) return;
      e.preventDefault();
      zone.style.outline = `2px dashed color-mix(in srgb, var(--accent) 55%, transparent)`;
      zone.style.outlineOffset = "4px";
    });
    zone.addEventListener("dragleave", () => {
      zone.style.outline = "";
      zone.style.outlineOffset = "";
    });
  });
}

function renderTasks() {
  const root = el("columns");
  const tasks = filteredTasks();
  const groupBy = state.filter.groupBy;
  for (const status of COLUMN_IDS) {
    const list = root.querySelector(`.task-list[data-status="${CSS.escape(status)}"]`);
    if (!list) continue;
    const columnTasks = tasks.filter((t) => t.status === status).sort(byOrderThenDate);

    if (groupBy === "none") {
      list.innerHTML = columnTasks.map(renderTaskCard).join("");
      continue;
    }

    const byGroup = new Map();
    for (const t of columnTasks) {
      const key = groupKeyForTask(t);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(t);
    }

    const keys = groupOrderKeys(byGroup.keys());
    list.innerHTML = keys
      .map((k) => {
        const label = groupLabelForKey(k);
        const header = `<div class="count-pill" style="margin:4px 0 2px; align-self:flex-start;">${escapeText(
          label,
        )}</div>`;
        const items = (byGroup.get(k) || []).map(renderTaskCard).join("");
        return `${header}${items}`;
      })
      .join("");
  }

  root.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.taskId;
      const task = state.tasksById.get(id);
      if (!task) return;
      if (state.bulk.enabled) toggleSelected(id);
      else openTaskModal({ mode: "edit", task });
    });

    card.addEventListener("keydown", (e) => onCardKeyDown(e, card));

    if (state.filter.groupBy === "none" && !state.bulk.enabled) {
      card.addEventListener("dragstart", onDragStart);
      card.addEventListener("dragend", onDragEnd);
    }

    card.querySelectorAll(".mini-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = card.dataset.taskId;
        const task = state.tasksById.get(id);
        if (!task) return;
        const dir = btn.dataset.dir;
        const target = dir === "left" ? prevStatus(task.status) : nextStatus(task.status);
        await moveTask(id, target, { source: "quick" });
      });
    });

    const check = card.querySelector(".bulk-check");
    if (check) {
      check.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSelected(card.dataset.taskId);
      });
    }
  });
}

function renderTaskCard(task) {
  const color = task.color || "#4f46e5";
  const priority = task.priority || "";
  const due = task.dueDate ? `Due: ${String(task.dueDate).slice(0, 10)}` : "";
  const labels = Array.isArray(task.labels) ? task.labels.slice(0, 2) : [];

  const badges = [];
  if (priority === "high" || priority === "medium" || priority === "low") {
    badges.push(`<span class="badge ${escapeText(priority)}">${escapeText(priority)}</span>`);
  }
  if (task.blocked) badges.push(`<span class="badge high">blocked</span>`);
  if (task.assignee) badges.push(`<span class="badge">Assigned: ${escapeText(task.assignee)}</span>`);
  if (task.epicId && state.epicsById.has(task.epicId)) {
    badges.push(`<span class="badge">Epic: ${escapeText(state.epicsById.get(task.epicId).name || "Epic")}</span>`);
  }
  if (due) badges.push(`<span class="badge">${escapeText(due)}</span>`);
  for (const l of labels) badges.push(`<span class="badge">${escapeText(l)}</span>`);

  const desc = (task.description || "").trim().replace(/\s+/g, " ");
  const descHtml = desc ? `<div class="task-desc">${escapeText(desc.slice(0, 160))}</div>` : "";

  const bulkCheck = state.bulk.enabled
    ? `<input class="bulk-check" type="checkbox" ${state.bulk.selected.has(task.id) ? "checked" : ""} aria-label="Select task" />`
    : "";
  const bulkClass = state.bulk.enabled ? "bulk" : "";
  const selectedClass = state.bulk.selected.has(task.id) ? "selected" : "";
  const blockedClass = task.blocked ? "blocked" : "";
  const draggable = state.filter.groupBy === "none" && !state.bulk.enabled ? 'draggable="true"' : 'draggable="false"';

  return `
    <article class="task-card ${bulkClass} ${selectedClass} ${blockedClass}" role="listitem" tabindex="0" ${draggable} data-task-id="${escapeText(
      task.id,
    )}">
      ${bulkCheck}
      <div class="task-actions">
        <button class="mini-btn" type="button" data-dir="left" aria-label="Move left">&lt;</button>
        <button class="mini-btn" type="button" data-dir="right" aria-label="Move right">&gt;</button>
      </div>
      <div class="task-title">
        <span class="task-color" style="background:${escapeText(color)}" aria-hidden="true"></span>
        <span>${escapeText(task.title || "Untitled task")}</span>
      </div>
      ${descHtml}
      <div class="task-meta">
        ${badges.join("")}
        <span class="badge">Updated: ${escapeText(shortDate(task.updatedAt))}</span>
      </div>
    </article>
  `;
}

function renderBulkBar() {
  const bar = document.getElementById("bulkBar");
  if (!bar) return;
  if (!state.bulk.enabled) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const count = document.getElementById("bulkCount");
  if (count) count.textContent = `${state.bulk.selected.size} selected`;
  const select = document.getElementById("bulkMoveStatus");
  if (select) fillStatusOptions(select);
}

function setBulkEnabled(enabled) {
  state.bulk.enabled = Boolean(enabled);
  if (!state.bulk.enabled) state.bulk.selected.clear();
  const btn = document.getElementById("bulkToggleBtn");
  if (btn) {
    btn.setAttribute("aria-pressed", String(state.bulk.enabled));
    btn.textContent = state.bulk.enabled ? "Bulk: on" : "Bulk";
  }
  renderBulkBar();
  renderColumns();
}

function toggleSelected(taskId) {
  if (state.bulk.selected.has(taskId)) state.bulk.selected.delete(taskId);
  else state.bulk.selected.add(taskId);
  renderBulkBar();
  renderColumns();
}

async function undoLast() {
  const undo = state.undo;
  state.undo = null;
  if (!undo) return;
  try {
    if (undo.type === "restore_tasks") {
      await saveTasks(undo.tasks);
      for (const t of undo.tasks) state.tasksById.set(t.id, normalizeTask(t));
      state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
      showToast("Undone.", { timeoutMs: 2400 });
      renderColumns();
    }
  } catch (err) {
    showToast(err?.message || "Undo failed.", { kind: "error" });
  }
}

async function moveTask(taskId, toStatus, { source = "move" } = {}) {
  const task = state.tasksById.get(taskId);
  if (!task || task.status === toStatus) return;

  if (!canPlaceInStatus(toStatus, { excludingTaskId: taskId })) {
    showToast(`WIP limit reached for ${COLUMN_LABELS[toStatus]}.`, { kind: "error" });
    return;
  }

  const before = { ...task };
  const ts = nowISO();
  const updated = normalizeTask({
    ...task,
    status: toStatus,
    updatedAt: ts,
    order: nextOrderForStatus(toStatus),
    doneAt: toStatus === "done" ? (task.doneAt || ts) : task.doneAt || "",
  });

  try {
    await saveTask(updated);
    state.tasksById.set(updated.id, updated);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("task_moved", { taskId, from: before.status, to: toStatus, source });

    state.undo = { type: "restore_tasks", tasks: [before] };
    showToast(`Moved to ${COLUMN_LABELS[toStatus]}.`, {
      actions: [{ label: "Undo", onClick: () => undoLast() }],
      timeoutMs: 6000,
    });

    await recordActiveSprintSnapshot();
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Move failed.", { kind: "error" });
  }
}

async function reorderWithinStatus(taskId, direction) {
  const task = state.tasksById.get(taskId);
  if (!task) return;
  const list = state.tasks
    .filter((t) => {
      if (t.status !== task.status) return false;
      if (state.viewMode === "scrum" && state.activeSprintId) return t.sprintId === state.activeSprintId;
      return true;
    })
    .sort(byOrderThenDate);
  const idx = list.findIndex((t) => t.id === taskId);
  if (idx < 0) return;
  const swapWith = direction === "up" ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= list.length) return;
  const a = list[idx];
  const b = list[swapWith];

  const ts = nowISO();
  const updatedA = normalizeTask({ ...a, order: b.order, updatedAt: ts });
  const updatedB = normalizeTask({ ...b, order: a.order, updatedAt: ts });

  try {
    await saveTasks([updatedA, updatedB]);
    state.tasksById.set(updatedA.id, updatedA);
    state.tasksById.set(updatedB.id, updatedB);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("task_reordered", { taskId: a.id, withTaskId: b.id, status: task.status });

    state.undo = { type: "restore_tasks", tasks: [a, b] };
    showToast("Reordered.", { actions: [{ label: "Undo", onClick: () => undoLast() }], timeoutMs: 5000 });
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Reorder failed.", { kind: "error" });
  }
}

function onCardKeyDown(e, card) {
  const id = card.dataset.taskId;
  const task = state.tasksById.get(id);
  if (!task) return;

  if (state.bulk.enabled && (e.key === " " || e.key === "Spacebar")) {
    e.preventDefault();
    toggleSelected(id);
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    openTaskModal({ mode: "edit", task });
    return;
  }

  if (e.key === "ArrowLeft") {
    e.preventDefault();
    moveTask(id, prevStatus(task.status), { source: "keyboard" });
    return;
  }

  if (e.key === "ArrowRight") {
    e.preventDefault();
    moveTask(id, nextStatus(task.status), { source: "keyboard" });
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    reorderWithinStatus(id, "up");
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    reorderWithinStatus(id, "down");
  }
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll(".task-card:not(.is-dragging)")];

  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - (box.top + box.height / 2);
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null },
  ).element;
}

function onDragStart(e) {
  if (state.bulk.enabled) return;
  if (state.filter.groupBy !== "none") return;
  const card = e.currentTarget;

  if (state.viewMode === "scrum") {
    const allowed = card.closest("#sprintColumns, #plannedSprints, #backlogList");
    if (!allowed) return;
    if (card.closest("#sprintColumns")) state.draggingFrom = { type: "activeSprint" };
    else if (card.closest("#plannedSprints")) {
      const sprintId = card.closest("[data-sprint-id]")?.dataset?.sprintId || "";
      state.draggingFrom = { type: "plannedSprint", sprintId };
    } else state.draggingFrom = { type: "backlog" };
  } else {
    state.draggingFrom = { type: "kanban" };
  }

  state.draggingEl = card;
  card.classList.add("is-dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", card.dataset.taskId);
}

function onDragEnd() {
  if (state.draggingEl) state.draggingEl.classList.remove("is-dragging");
  state.draggingEl = null;
  state.draggingFrom = null;
  document.querySelectorAll(".task-list").forEach((l) => {
    l.style.outline = "";
    l.style.outlineOffset = "";
  });
  document.querySelectorAll(".backlog-list, .planned-body").forEach((l) => {
    l.style.outline = "";
    l.style.outlineOffset = "";
  });
}

function onDragOver(e) {
  if (state.filter.groupBy !== "none" || state.bulk.enabled) return;
  if (state.viewMode === "scrum") {
    const zone = e.currentTarget;
    if (zone.classList.contains("task-list")) {
      if (!state.activeSprintId) return;
      if (!zone.closest("#sprintColumns")) return;
    } else if (zone.id === "backlogList") {
      // ok
    } else if (zone.classList.contains("planned-body")) {
      // ok
    } else {
      return;
    }
  }
  e.preventDefault();
  if (!state.draggingEl) return;
  const container = e.currentTarget;
  const afterElement = getDragAfterElement(container, e.clientY);
  if (afterElement == null) container.appendChild(state.draggingEl);
  else container.insertBefore(state.draggingEl, afterElement);
}

async function onDrop(e) {
  if (state.filter.groupBy !== "none" || state.bulk.enabled) return;
  e.preventDefault();
  if (!state.draggingEl) return;

  if (state.viewMode !== "scrum") {
    const root = e.currentTarget.closest(".columns") || el("columns");
    await persistTaskPositionsFromDOM(root);
    await reloadAndRerender();
    return;
  }

  await persistScrumAssignmentsFromDOM();
  await reloadAndRerender();
}

async function persistTaskPositionsFromDOM(rootEl, { defaultSprintId = null } = {}) {
  const root = rootEl || el("columns");
  const updates = [];
  const touchedTaskIds = new Set();

  const nextCounts = Object.fromEntries(COLUMN_IDS.map((c) => [c, 0]));
  for (const status of COLUMN_IDS) {
    const list = root.querySelector(`.task-list[data-status="${CSS.escape(status)}"]`);
    if (!list) continue;
    nextCounts[status] = [...list.querySelectorAll(".task-card")].length;
  }
  for (const status of COLUMN_IDS) {
    const limit = wipLimitFor(status);
    if (limit && nextCounts[status] > limit) {
      showToast(`WIP limit reached for ${COLUMN_LABELS[status]}.`, { kind: "error" });
      return;
    }
  }

  for (const status of COLUMN_IDS) {
    const list = root.querySelector(`.task-list[data-status="${CSS.escape(status)}"]`);
    if (!list) continue;
    const ids = [...list.querySelectorAll(".task-card")].map((n) => n.dataset.taskId);
    ids.forEach((taskId, idx) => {
      const existing = state.tasksById.get(taskId);
      if (!existing) return;
      touchedTaskIds.add(taskId);
      const nextSprintId = defaultSprintId != null ? defaultSprintId : existing.sprintId || "";
      if (existing.status !== status || existing.order !== idx || (existing.sprintId || "") !== (nextSprintId || "")) {
        const ts = nowISO();
        updates.push(
          normalizeTask({
            ...existing,
            status,
            order: idx,
            updatedAt: ts,
            sprintId: nextSprintId,
            doneAt: status === "done" ? (existing.doneAt || ts) : existing.doneAt || "",
          }),
        );
      }
    });
  }

  if (!updates.length) return;
  const before = updates.map((u) => ({ ...state.tasksById.get(u.id) })).filter(Boolean);
  try {
    await saveTasks(updates);
    for (const t of updates) state.tasksById.set(t.id, t);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("task_dragdrop", { count: updates.length });
    await recordActiveSprintSnapshot();

    state.undo = { type: "restore_tasks", tasks: before };
    showToast("Updated.", { actions: [{ label: "Undo", onClick: () => undoLast() }], timeoutMs: 5000 });
  } catch (err) {
    showToast(err?.message || "Update failed.", { kind: "error" });
  }

  for (const id of touchedTaskIds) {
    const t = state.tasksById.get(id);
    if (!t) continue;
    if (t.order < 0) t.order = 0;
  }
}

async function persistScrumAssignmentsFromDOM() {
  const activeSprintId = state.activeSprintId || "";

  // 1) Persist sprint board columns (status/order + sprint assignment)
  if (activeSprintId) {
    await persistTaskPositionsFromDOM(document.getElementById("sprintColumns"), { defaultSprintId: activeSprintId });
  }

  // 2) Persist planned sprint lists (assignment only)
  const plannedRoot = document.getElementById("plannedSprints");
  const backlogRoot = document.getElementById("backlogList");

  const updates = [];
  const scopeChanges = [];

  if (plannedRoot) {
    plannedRoot.querySelectorAll("[data-sprint-id] .planned-body").forEach((body) => {
      const sprintId = body.closest("[data-sprint-id]")?.dataset?.sprintId || "";
      if (!sprintId) return;
      body.querySelectorAll(".task-card").forEach((card) => {
        const id = card.dataset.taskId;
        const existing = state.tasksById.get(id);
        if (!existing) return;
        if ((existing.sprintId || "") !== sprintId) {
          const ts = nowISO();
          updates.push(normalizeTask({ ...existing, sprintId, updatedAt: ts }));
          scopeChanges.push({ taskId: existing.id, fromSprintId: existing.sprintId || "", toSprintId: sprintId });
        }
      });
    });
  }

  // 3) Persist backlog list (assignment only)
  if (backlogRoot) {
    backlogRoot.querySelectorAll(".task-card").forEach((card) => {
      const id = card.dataset.taskId;
      const existing = state.tasksById.get(id);
      if (!existing) return;
      if (existing.sprintId) {
        const ts = nowISO();
        updates.push(normalizeTask({ ...existing, sprintId: "", updatedAt: ts }));
        scopeChanges.push({ taskId: existing.id, fromSprintId: existing.sprintId || "", toSprintId: "" });
      }
    });
  }

  if (!updates.length) return;
  try {
    await saveTasks(updates);
    for (const t of updates) state.tasksById.set(t.id, t);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);

    for (const change of scopeChanges) {
      await noteSprintScopeChange(change);
    }

    await logEvent("task_sprint_assignment_drag", { count: updates.length });
    await recordActiveSprintSnapshot();
    showToast("Updated.", { timeoutMs: 2200 });
  } catch (err) {
    showToast(err?.message || "Update failed.", { kind: "error" });
  }
}

function trapFocus(modalEl) {
  function getFocusable() {
    return [...modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((n) => !n.hasAttribute("disabled") && !n.closest("[hidden]"));
  }
  function onKeyDown(e) {
    if (e.key !== "Tab") return;
    const nodes = getFocusable();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  modalEl.addEventListener("keydown", onKeyDown);
  return () => modalEl.removeEventListener("keydown", onKeyDown);
}

function openOverlayModal(modalId) {
  el("modalBackdrop").hidden = false;
  el(modalId).hidden = false;
  document.body.style.overflow = "hidden";
  state.modal.openId = modalId;
  state.modal.focusTrapCleanup?.();
  state.modal.focusTrapCleanup = trapFocus(el(modalId));
}

function closeOverlayModal(modalId, { force = false, confirmDirty = false } = {}) {
  if (!force && confirmDirty && state.modal.dirty) {
    if (!confirm("Discard unsaved changes?")) return false;
  }

  el(modalId).hidden = true;
  state.modal.focusTrapCleanup?.();
  state.modal.focusTrapCleanup = null;

  const anyOpen =
    !el("taskModal").hidden ||
    !el("settingsModal").hidden ||
    !el("insightsModal").hidden ||
    !el("epicsModal").hidden ||
    !el("sprintModal").hidden ||
    !el("sprintReportModal").hidden;
  if (!anyOpen) {
    el("modalBackdrop").hidden = true;
    document.body.style.overflow = "";
    state.modal.openId = null;
  } else if (state.modal.openId === modalId) {
    state.modal.openId = !el("taskModal").hidden
      ? "taskModal"
      : !el("settingsModal").hidden
        ? "settingsModal"
        : !el("insightsModal").hidden
          ? "insightsModal"
          : !el("epicsModal").hidden
            ? "epicsModal"
            : !el("sprintModal").hidden
              ? "sprintModal"
              : !el("sprintReportModal").hidden
                ? "sprintReportModal"
            : null;
  }
  return true;
}

function openModal() {
  openOverlayModal("taskModal");
}

function closeModal({ force = false } = {}) {
  const ok = closeOverlayModal("taskModal", { force, confirmDirty: true });
  if (!ok) return;
  state.modal.openId = null;
  state.modal.dirty = false;
  state.modal.preview = false;
  const preview = document.getElementById("mdPreview");
  if (preview) preview.hidden = true;
  const toggle = document.getElementById("togglePreviewBtn");
  if (toggle) toggle.textContent = "Preview";
}

function fillStatusOptions(selectEl) {
  selectEl.innerHTML = COLUMN_IDS.map(
    (s) => `<option value="${escapeText(s)}">${escapeText(COLUMN_LABELS[s] || s)}</option>`,
  ).join("");
}

function fillEpicOptions(selectEl, selectedId) {
  if (!selectEl) return;
  const opts = [`<option value="">None</option>`].concat(
    state.epics.map((e) => `<option value="${escapeText(e.id)}">${escapeText(e.name || "Epic")}</option>`),
  );
  selectEl.innerHTML = opts.join("");
  if (selectedId) selectEl.value = selectedId;
}

function fillSprintOptions(selectEl, selectedId) {
  if (!selectEl) return;
  const assignable = state.sprints.filter((s) => s.status !== "completed");
  const selectedSprint = selectedId ? state.sprintsById.get(selectedId) : null;
  if (!assignable.length) {
    selectEl.innerHTML = `<option value="">Backlog (no sprints yet)</option>`;
    selectEl.value = "";
    return;
  }
  const opts = [`<option value="">Backlog</option>`].concat(
    assignable.map((s) => `<option value="${escapeText(s.id)}">${escapeText(s.name || "Sprint")}</option>`),
  );
  if (selectedSprint && selectedSprint.status === "completed") {
    opts.push(
      `<option value="${escapeText(selectedSprint.id)}" disabled>${escapeText(
        selectedSprint.name || "Completed sprint",
      )} (completed)</option>`,
    );
  }
  selectEl.innerHTML = opts.join("");
  if (selectedId) selectEl.value = selectedId;
}

function normalizeUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function renderChecklist(items) {
  const root = document.getElementById("checklistList");
  if (!root) return;
  root.innerHTML = (items || [])
    .map(
      (it) => `
        <div class="list-item" data-check-id="${escapeText(it.id)}">
          <div class="list-item-left">
            <input type="checkbox" ${it.done ? "checked" : ""} aria-label="Checklist done" />
            <input type="text" class="input" value="${escapeText(it.text)}" style="padding:8px 10px;" />
          </div>
          <button class="btn btn-danger" type="button" data-remove="1">Remove</button>
        </div>
      `,
    )
    .join("");

  root.querySelectorAll("input").forEach((n) =>
    n.addEventListener("input", () => {
      state.modal.dirty = true;
    }),
  );
  root.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest("[data-check-id]")?.remove();
      state.modal.dirty = true;
    });
  });
}

function readChecklistFromUI() {
  const root = document.getElementById("checklistList");
  if (!root) return [];
  const rows = [...root.querySelectorAll("[data-check-id]")];
  return rows
    .map((r) => ({
      id: r.dataset.checkId,
      text: r.querySelector("input[type='text']")?.value || "",
      done: Boolean(r.querySelector("input[type='checkbox']")?.checked),
    }))
    .filter((x) => x.text.trim());
}

function renderAttachments(urls) {
  const root = document.getElementById("attachmentsList");
  if (!root) return;
  root.innerHTML = (urls || [])
    .map((url) => {
      const safe = escapeText(url);
      return `
        <div class="list-item" data-url="${safe}">
          <div class="list-item-left">
            <a class="list-item-text" href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>
          </div>
          <button class="btn btn-danger" type="button" data-remove="1">Remove</button>
        </div>
      `;
    })
    .join("");

  root.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest("[data-url]")?.remove();
      state.modal.dirty = true;
    });
  });
}

function readAttachmentsFromUI() {
  const root = document.getElementById("attachmentsList");
  if (!root) return [];
  return [...root.querySelectorAll("[data-url]")].map((r) => r.dataset.url).filter(Boolean);
}

function escapeAndLinkify(text) {
  const escaped = escapeText(text);
  return escaped.replace(
    /(https?:\/\/[^\s<]+[^\s<\.)\]])/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`,
  );
}

function renderMarkdown(md) {
  const base = escapeAndLinkify(String(md || ""));
  const lines = base.split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const line of lines) {
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${li[1]}</li>`);
      continue;
    }
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    out.push(line);
  }
  if (inList) out.push("</ul>");

  const joined = out
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)(?!\s)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br/>");

  return `<p>${joined}</p>`;
}

function openTaskModal({ mode, task, initialStatus, initialSprintId }) {
  const idInput = el("taskId");
  const titleInput = el("taskTitle");
  const descInput = el("taskDescription");
  const statusSelect = el("taskStatus");
  const prioritySelect = el("taskPriority");
  const colorInput = el("taskColor");
  const deleteBtn = el("deleteTaskBtn");
  const dates = el("taskDates");
  const assignee = document.getElementById("taskAssignee");
  const due = document.getElementById("taskDueDate");
  const labels = document.getElementById("taskLabels");
  const blocked = document.getElementById("taskBlocked");
  const duplicateBtn = document.getElementById("duplicateTaskBtn");
  const epicSelect = document.getElementById("taskEpic");
  const sprintSelect = document.getElementById("taskSprint");

  fillStatusOptions(statusSelect);
  fillEpicOptions(epicSelect, task?.epicId || "");
  fillSprintOptions(sprintSelect, task?.sprintId || "");

  if (mode === "edit" && task) {
    el("taskModalTitle").textContent = "Edit task";
    idInput.value = task.id;
    titleInput.value = task.title || "";
    descInput.value = task.description || "";
    statusSelect.value = task.status || "todo";
    prioritySelect.value = task.priority || "";
    colorInput.value = task.color || "#4f46e5";
    if (assignee) assignee.value = task.assignee || "";
    if (due) due.value = task.dueDate ? String(task.dueDate).slice(0, 10) : "";
    if (labels) labels.value = (task.labels || []).join(", ");
    if (blocked) blocked.checked = Boolean(task.blocked);
    if (epicSelect) epicSelect.value = task.epicId || "";
    if (sprintSelect) sprintSelect.value = task.sprintId || "";
    renderChecklist(task.checklist || []);
    renderAttachments(task.attachments || []);
    deleteBtn.hidden = false;
    if (duplicateBtn) duplicateBtn.hidden = false;
    dates.textContent = `Created: ${shortDate(task.createdAt)} | Updated: ${shortDate(task.updatedAt)}`;
  } else {
    el("taskModalTitle").textContent = "New task";
    idInput.value = "";
    titleInput.value = "";
    descInput.value = "";
    statusSelect.value = initialStatus || "todo";
    prioritySelect.value = "";
    colorInput.value = "#4f46e5";
    if (assignee) assignee.value = "";
    if (due) due.value = "";
    if (labels) labels.value = "";
    if (blocked) blocked.checked = false;
    if (epicSelect) epicSelect.value = "";
    if (sprintSelect) sprintSelect.value = initialSprintId || "";
    renderChecklist([]);
    renderAttachments([]);
    deleteBtn.hidden = true;
    if (duplicateBtn) duplicateBtn.hidden = true;
    dates.textContent = "";
  }

  state.modal.dirty = false;
  state.modal.preview = false;
  const preview = document.getElementById("mdPreview");
  if (preview) preview.hidden = true;
  const toggle = document.getElementById("togglePreviewBtn");
  if (toggle) toggle.textContent = "Preview";

  openModal();
  titleInput.focus();
}

function nextOrderForStatus(status) {
  const tasks = state.tasks.filter((t) => {
    if (t.status !== status) return false;
    if (state.viewMode === "scrum" && state.activeSprintId) return t.sprintId === state.activeSprintId;
    return true;
  });
  const max = tasks.reduce((m, t) => Math.max(m, typeof t.order === "number" ? t.order : 0), -1);
  return max + 1;
}

async function onSaveTask(e) {
  e.preventDefault();
  const id = el("taskId").value.trim();
  const title = el("taskTitle").value.trim();
  const description = el("taskDescription").value || "";
  let status = el("taskStatus").value;
  const priority = el("taskPriority").value || "";
  const color = el("taskColor").value || "";
  const assignee = (document.getElementById("taskAssignee")?.value || "").trim();
  const dueRaw = document.getElementById("taskDueDate")?.value || "";
  const dueDate = dueRaw ? `${dueRaw}T00:00:00.000Z` : "";
  const labels = parseLabels(document.getElementById("taskLabels")?.value || "");
  const epicId = document.getElementById("taskEpic")?.value || "";
  const sprintId = document.getElementById("taskSprint")?.value || "";
  const blocked = Boolean(document.getElementById("taskBlocked")?.checked);
  const checklist = readChecklistFromUI();
  const attachments = readAttachmentsFromUI();

  if (!title) {
    el("taskTitle").focus();
    return;
  }

  const existing = id ? state.tasksById.get(id) : null;
  const timestamp = nowISO();
  const isNew = !existing;

  let statusChanged = existing && existing.status !== status;

  statusChanged = existing && existing.status !== status;

  if (!canPlaceInStatus(status, { excludingTaskId: existing?.id || null })) {
    showToast(`WIP limit reached for ${COLUMN_LABELS[status]}.`, { kind: "error" });
    return;
  }

  const doneAt = status === "done" ? existing?.doneAt || timestamp : existing?.doneAt || "";

  const task = normalizeTask({
    id: existing?.id || makeId(),
    boardId: state.activeBoardId,
    title,
    description,
    status,
    priority,
    color,
    assignee,
    epicId,
    sprintId,
    dueDate,
    labels,
    blocked,
    checklist,
    attachments,
    doneAt,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    order: isNew || statusChanged ? nextOrderForStatus(status) : existing.order ?? 0,
  });

  try {
    await saveTask(task);
    if (existing && (existing.sprintId || "") !== (task.sprintId || "")) {
      await noteSprintScopeChange({
        fromSprintId: existing.sprintId || "",
        toSprintId: task.sprintId || "",
        taskId: task.id,
      });
    }
    state.tasksById.set(task.id, task);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);

    await logEvent(isNew ? "task_created" : statusChanged ? "task_moved" : "task_updated", {
      taskId: task.id,
      from: existing?.status || null,
      to: task.status,
    });

    state.modal.dirty = false;
    closeModal({ force: true });
    showToast("Saved.", { timeoutMs: 2200 });
    await recordActiveSprintSnapshot();
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Save failed.", { kind: "error" });
  }
}

async function onDeleteTask() {
  const id = el("taskId").value.trim();
  if (!id) return;
  const task = state.tasksById.get(id);
  if (!task) return;
  if (!confirm(`Delete "${task.title}"?`)) return;

  try {
    await deleteTask(id);
    state.tasksById.delete(id);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("task_deleted", { taskId: id, from: task.status });

    state.undo = { type: "restore_tasks", tasks: [{ ...task }] };
    showToast("Deleted.", { actions: [{ label: "Undo", onClick: () => undoLast() }], timeoutMs: 7000 });

    state.modal.dirty = false;
    closeModal({ force: true });
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Delete failed.", { kind: "error" });
  }
}

async function onDuplicateTask() {
  const id = el("taskId").value.trim();
  if (!id) return;
  const task = state.tasksById.get(id);
  if (!task) return;

  if (!canPlaceInStatus("todo")) {
    showToast(`WIP limit reached for ${COLUMN_LABELS.todo}.`, { kind: "error" });
    return;
  }

  const ts = nowISO();
  const copy = normalizeTask({
    ...task,
    id: makeId(),
    title: `${task.title} (copy)`,
    status: "todo",
    order: nextOrderForStatus("todo"),
    createdAt: ts,
    updatedAt: ts,
    doneAt: "",
  });

  try {
    await saveTask(copy);
    state.tasksById.set(copy.id, copy);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("task_duplicated", { fromTaskId: task.id, taskId: copy.id });
    showToast("Duplicated to To Do.", { timeoutMs: 2500 });
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Duplicate failed.", { kind: "error" });
  }
}

async function onMoveLeftRight(dir) {
  const id = el("taskId").value.trim();
  if (!id) {
    const statusSelect = el("taskStatus");
    statusSelect.value = dir === "left" ? prevStatus(statusSelect.value) : nextStatus(statusSelect.value);
    state.modal.dirty = true;
    return;
  }
  const task = state.tasksById.get(id);
  if (!task) return;
  const target = dir === "left" ? prevStatus(task.status) : nextStatus(task.status);
  await moveTask(id, target, { source: "modal" });
  const refreshed = state.tasksById.get(id);
  if (refreshed) openTaskModal({ mode: "edit", task: refreshed });
}

async function reloadAndRerender() {
  await loadBoardsAndActive();
  await loadTasks();
  await loadEpics();
  await loadSprints();
  renderBoardSelect();
  const groupBy = document.getElementById("groupBy");
  if (groupBy) groupBy.value = state.filter.groupBy;
  const viewMode = document.getElementById("viewMode");
  if (viewMode) viewMode.value = state.viewMode;
  syncViewModeUi();
  renderBulkBar();
  render();
}

async function onQuickAdd() {
  const input = document.getElementById("quickAddTitle");
  if (!input) return;
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }
  if (!canPlaceInStatus("todo")) {
    showToast(`WIP limit reached for ${COLUMN_LABELS.todo}.`, { kind: "error" });
    return;
  }

  const ts = nowISO();
  const task = normalizeTask({
    id: makeId(),
    boardId: state.activeBoardId,
    title,
    description: "",
    status: "todo",
    priority: "",
    color: "#4f46e5",
    assignee: "",
    epicId: "",
    sprintId: "",
    dueDate: "",
    labels: [],
    blocked: false,
    checklist: [],
    attachments: [],
    doneAt: "",
    createdAt: ts,
    updatedAt: ts,
    order: nextOrderForStatus("todo"),
  });

  try {
    await saveTask(task);
    state.tasksById.set(task.id, task);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("task_created", { taskId: task.id, quick: true });
    input.value = "";
    showToast("Added.", { timeoutMs: 2000 });
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Add failed.", { kind: "error" });
  }
}

async function onResetBoard() {
  const board = state.activeBoard;
  if (!board) return;
  if (!confirm(`Remove all tasks from "${board.name}"?`)) return;
  try {
    await deleteTasksByBoardId(board.id);
    await logEvent("board_reset", { boardId: board.id });
    state.tasksById.clear();
    state.tasks = [];
    showToast("Board reset.", { timeoutMs: 2400 });
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Reset failed.", { kind: "error" });
  }
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function onExportBoard() {
  const board = state.activeBoard;
  if (!board) return;
  const payload = {
    version: 1,
    exportedAt: nowISO(),
    board,
    tasks: state.tasks,
  };
  downloadJson(`${board.name.replace(/[^\w.-]+/g, "_")}.json`, payload);
  showToast("Exported.", { timeoutMs: 2200 });
}

async function onImportFile(file) {
  let json;
  try {
    json = JSON.parse(await file.text());
  } catch {
    showToast("Invalid JSON.", { kind: "error" });
    return;
  }
  if (!json || !json.board || !Array.isArray(json.tasks)) {
    showToast("Import file missing board/tasks.", { kind: "error" });
    return;
  }

  const createNew = confirm("Import into a NEW board? (Cancel = merge into current board)");
  const importedTasks = json.tasks.map((t) => normalizeTask(t));

  try {
    if (createNew) {
      const created = await createBoard(`${(json.board.name || "Imported").trim() || "Imported"} (import)`);
      await updateBoardSettings(created.id, {
        wipLimits: ensureBoardDefaults(json.board).wipLimits,
        columnPolicies: ensureBoardDefaults(json.board).columnPolicies,
        groupBy: ensureBoardDefaults(json.board).groupBy,
      });
      for (const t of importedTasks) {
        t.id = t.id || makeId();
        t.boardId = created.id;
        t.updatedAt = nowISO();
      }
      await saveTasks(importedTasks);
      await setActiveBoardId(created.id);
      state.activeBoardId = created.id;
      await logEvent("import", { mode: "new", count: importedTasks.length });
    } else {
      const existingIds = new Set(state.tasksById.keys());
      for (const t of importedTasks) {
        t.id = t.id || makeId();
        if (existingIds.has(t.id)) t.id = makeId();
        t.boardId = state.activeBoardId;
        t.updatedAt = nowISO();
      }
      await saveTasks(importedTasks);
      await logEvent("import", { mode: "merge", count: importedTasks.length });
    }
    showToast("Imported.", { timeoutMs: 2400 });
    await reloadAndRerender();
  } catch (err) {
    showToast(err?.message || "Import failed.", { kind: "error" });
  }
}

function openSettingsModal() {
  const board = state.activeBoard;
  if (!board) return;
  const groupBy = document.getElementById("settingsGroupBy");
  if (groupBy) groupBy.value = board.groupBy || "none";

  const wipGrid = document.getElementById("wipGrid");
  if (wipGrid) {
    wipGrid.innerHTML = COLUMN_IDS.map((c) => {
      const label = COLUMN_LABELS[c] || c;
      const v = board.wipLimits?.[c];
      return `
        <div class="grid-row">
          <div class="field-label">${escapeText(label)} WIP limit</div>
          <input class="input" type="number" min="1" step="1" data-wip="${escapeText(c)}" value="${escapeText(
            v == null ? "" : String(v),
          )}" placeholder="No limit" />
        </div>
      `;
    }).join("");
  }

  const policyGrid = document.getElementById("policyGrid");
  if (policyGrid) {
    policyGrid.innerHTML = COLUMN_IDS.map((c) => {
      const label = COLUMN_LABELS[c] || c;
      const v = (board.columnPolicies?.[c] || "").trim();
      return `
        <div class="grid-row">
          <div class="field-label">${escapeText(label)} policy</div>
          <textarea class="textarea" rows="2" data-policy="${escapeText(c)}" placeholder="Optional policy.">${escapeText(
            v,
          )}</textarea>
        </div>
      `;
    }).join("");
  }

  openOverlayModal("settingsModal");
}

async function onSaveSettings(e) {
  e.preventDefault();
  const wipLimits = {};
  document.querySelectorAll("#wipGrid [data-wip]").forEach((inp) => {
    const v = inp.value.trim();
    wipLimits[inp.dataset.wip] = v ? Math.max(1, Math.floor(Number(v))) : null;
  });
  const columnPolicies = {};
  document.querySelectorAll("#policyGrid [data-policy]").forEach((ta) => {
    columnPolicies[ta.dataset.policy] = ta.value || "";
  });
  const groupBy = document.getElementById("settingsGroupBy")?.value || "none";

  try {
    await updateBoardSettings(state.activeBoardId, { wipLimits, columnPolicies, groupBy });
    await logEvent("board_settings", { groupBy });
    closeOverlayModal("settingsModal", { force: true });
    await reloadAndRerender();
    showToast("Settings saved.", { timeoutMs: 2200 });
  } catch (err) {
    showToast(err?.message || "Settings save failed.", { kind: "error" });
  }
}

async function onGroupByChange(value) {
  state.filter.groupBy = value || "none";
  try {
    await updateBoardSettings(state.activeBoardId, { groupBy: state.filter.groupBy });
    await logEvent("board_settings", { groupBy: state.filter.groupBy });
    await loadBoardsAndActive();
  } catch {
    // ignore
  }
  renderColumns();
}

function syncViewModeUi() {
  const groupBy = document.getElementById("groupBy");
  if (groupBy) groupBy.disabled = state.viewMode === "scrum";
}

async function onViewModeChange(value) {
  const vm = value === "scrum" ? "scrum" : "kanban";
  state.viewMode = vm;
  try {
    await updateBoardSettings(state.activeBoardId, { viewMode: vm });
    await logEvent("board_settings", { viewMode: vm });
    await loadBoardsAndActive();
  } catch {
    // ignore
  }
  const viewMode = document.getElementById("viewMode");
  if (viewMode) viewMode.value = state.viewMode;
  syncViewModeUi();
  renderColumns();
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return `${days}d`;
}

async function openInsightsModal() {
  const tasks = state.tasks;
  const done = tasks.filter((t) => t.status === "done" && t.doneAt && t.createdAt);
  const cycleMs = done
    .map((t) => new Date(t.doneAt).getTime() - new Date(t.createdAt).getTime())
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  const counts = taskCounts(tasks);
  const avg = cycleMs.length ? cycleMs.reduce((a, b) => a + b, 0) / cycleMs.length : 0;
  const p50 = percentile(cycleMs, 50);
  const p90 = percentile(cycleMs, 90);

  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const doneCounts = Object.fromEntries(days.map((k) => [k, 0]));
  for (const t of done) {
    const k = String(t.doneAt || "").slice(0, 10);
    if (k && k in doneCounts) doneCounts[k] += 1;
  }
  const doneRows = days
    .map(
      (k) =>
        `<div class="list-item"><div class="list-item-left"><div class="list-item-text">${escapeText(
          k,
        )}</div></div><div class="muted">${doneCounts[k] || 0}</div></div>`,
    )
    .join("");

  const stats = document.getElementById("insightsStats");
  if (stats) {
    stats.innerHTML = `
      <div class="section">
        <div class="section-title">Snapshot</div>
        <div class="list">
          ${COLUMN_IDS.map(
            (c) =>
              `<div class="list-item"><div class="list-item-left"><div class="list-item-text">${escapeText(
                COLUMN_LABELS[c],
              )}</div></div><div class="muted">${counts[c] || 0}</div></div>`,
          ).join("")}
        </div>
      </div>
      <div class="section">
        <div class="section-title">Cycle time (Created -> Done)</div>
        <div class="list">
          <div class="list-item"><div class="list-item-left"><div class="list-item-text">Completed tasks</div></div><div class="muted">${cycleMs.length}</div></div>
          <div class="list-item"><div class="list-item-left"><div class="list-item-text">Average</div></div><div class="muted">${cycleMs.length ? formatDuration(avg) : "-"}</div></div>
          <div class="list-item"><div class="list-item-left"><div class="list-item-text">Median (P50)</div></div><div class="muted">${cycleMs.length ? formatDuration(p50) : "-"}</div></div>
          <div class="list-item"><div class="list-item-left"><div class="list-item-text">P90</div></div><div class="muted">${cycleMs.length ? formatDuration(p90) : "-"}</div></div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">Done last 7 days</div>
        <div class="list">
          ${doneRows}
        </div>
      </div>
    `;
  }

  const log = document.getElementById("activityLog");
  if (log) {
    const events = await getEvents(state.activeBoardId, { limit: 200 });
    log.innerHTML = events
      .slice(0, 80)
      .map((ev) => {
        const when = shortDate(ev.ts);
        const desc =
          ev.type === "task_moved"
            ? `Moved ${ev.payload?.from || "?"} -> ${ev.payload?.to || "?"}`
            : ev.type.replace(/_/g, " ");
        return `<div class="activity-row"><div>${escapeText(desc)}</div><div class="muted">${escapeText(
          when,
        )}</div></div>`;
      })
      .join("");
  }

  openOverlayModal("insightsModal");
}

function renderEpicsList() {
  const root = document.getElementById("epicsList");
  if (!root) return;
  const counts = new Map();
  for (const t of state.tasks) {
    if (!t.epicId) continue;
    counts.set(t.epicId, (counts.get(t.epicId) || 0) + 1);
  }

  root.innerHTML = state.epics
    .map((e) => {
      const c = counts.get(e.id) || 0;
      return `
        <div class="list-item" data-epic-id="${escapeText(e.id)}">
          <div class="list-item-left">
            <div class="list-item-text">${escapeText(e.name || "Epic")}</div>
            <span class="badge">${c} tasks</span>
          </div>
          <div class="inline">
            <button class="btn" type="button" data-rename="1">Rename</button>
            <button class="btn btn-danger" type="button" data-delete="1">Delete</button>
          </div>
        </div>
      `;
    })
    .join("");

  root.querySelectorAll("[data-rename]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("[data-epic-id]");
      const id = row?.dataset.epicId;
      const epic = state.epicsById.get(id);
      if (!epic) return;
      const name = prompt("Epic name:", epic.name || "Epic");
      if (!name) return;
      const updated = { ...epic, name: name.trim() || epic.name, updatedAt: nowISO() };
      await saveEpic(updated);
      await loadEpics();
      renderEpicsList();
      showToast("Epic saved.", { timeoutMs: 2200 });
    });
  });

  root.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("[data-epic-id]");
      const id = row?.dataset.epicId;
      const epic = state.epicsById.get(id);
      if (!epic) return;
      if (!confirm(`Delete epic "${epic.name}"? Tasks will be unlinked.`)) return;

      const affected = state.tasks.filter((t) => t.epicId === id).map((t) => ({ ...t, epicId: "", updatedAt: nowISO() }));
      try {
        if (affected.length) await saveTasks(affected);
        await deleteEpic(id);
        await logEvent("epic_deleted", { epicId: id, affected: affected.length });
        await loadTasks();
        await loadEpics();
        renderEpicsList();
        showToast("Epic deleted.", { timeoutMs: 2200 });
        renderColumns();
      } catch (err) {
        showToast(err?.message || "Epic delete failed.", { kind: "error" });
      }
    });
  });
}

async function openEpicsModal() {
  await loadEpics();
  renderEpicsList();
  openOverlayModal("epicsModal");
}

async function createEpicFromName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const epic = { id: makeId(), boardId: state.activeBoardId, name: trimmed, createdAt: nowISO(), updatedAt: nowISO() };
  await saveEpic(epic);
  await logEvent("epic_created", { epicId: epic.id });
  await loadEpics();
  return epic;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function createSprint({ name, startDate, endDate }) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const sprint = {
    id: makeId(),
    boardId: state.activeBoardId,
    name: trimmed,
    status: "planned",
    startDate: startDate || "",
    endDate: endDate || "",
    createdAt: nowISO(),
    startedAt: "",
    completedAt: "",
    committedTaskIds: [],
    addedTaskIds: [],
    removedTaskIds: [],
  };
  await saveSprint(sprint);
  await logEvent("sprint_created", { sprintId: sprint.id });
  await loadSprints();
  return sprint;
}

async function recordActiveSprintSnapshot() {
  const active = getActiveSprint();
  if (!active) return;
  const date = todayDate();
  const sprintTasks = state.tasks.filter((t) => t.sprintId === active.id);
  const remaining = sprintTasks.filter((t) => t.status !== "done").length;
  const done = sprintTasks.filter((t) => t.status === "done").length;
  const total = sprintTasks.length;
  await upsertSprintSnapshot({
    id: `${active.id}_${date}`,
    boardId: state.activeBoardId,
    sprintId: active.id,
    date,
    remaining,
    done,
    total,
    ts: nowISO(),
  });
}

async function startSprint(sprintId) {
  const selected = state.sprintsById.get(sprintId);
  if (!selected) return;
  if (getActiveSprint()) {
    showToast("A sprint is already active.", { kind: "error" });
    return;
  }
  if (selected.status !== "planned") {
    showToast("Only planned sprints can be started.", { kind: "error" });
    return;
  }

  const startedAt = nowISO();
  const startDate = selected.startDate || todayDate();
  const committed = state.tasks.filter((t) => t.sprintId === selected.id).map((t) => t.id);

  const updated = {
    ...selected,
    status: "active",
    startedAt,
    startDate,
    committedTaskIds: committed,
    addedTaskIds: [],
    removedTaskIds: [],
    updatedAt: startedAt,
  };

  await saveSprint(updated);
  await updateBoardSettings(state.activeBoardId, { viewMode: "scrum", activeSprintId: selected.id });
  await logEvent("sprint_started", { sprintId: selected.id, committed: committed.length });

  await reloadAndRerender();
  await recordActiveSprintSnapshot();
  showToast("Sprint started.", { timeoutMs: 2200 });
}

async function completeActiveSprint() {
  const active = getActiveSprint();
  if (!active) return;
  if (!confirm(`Complete sprint "${active.name}"? Incomplete issues will move to backlog.`)) return;

  const completedAt = nowISO();
  const updatedSprint = { ...active, status: "completed", completedAt, updatedAt: completedAt };

  const movedOut = state.tasks
    .filter((t) => t.sprintId === active.id && t.status !== "done")
    .map((t) => normalizeTask({ ...t, sprintId: "", updatedAt: completedAt }));

  await saveSprint(updatedSprint);
  if (movedOut.length) await saveTasks(movedOut);
  await updateBoardSettings(state.activeBoardId, { activeSprintId: null });
  await logEvent("sprint_completed", { sprintId: active.id, movedToBacklog: movedOut.length });

  await reloadAndRerender();
  showToast("Sprint completed.", { timeoutMs: 2200 });
}

async function deletePlannedSprint(sprintId) {
  const sprint = state.sprintsById.get(sprintId);
  if (!sprint) return;
  if (sprint.status !== "planned") {
    showToast("Only planned sprints can be deleted.", { kind: "error" });
    return;
  }
  if (!confirm(`Delete sprint "${sprint.name}"? Issues will move to backlog.`)) return;

  const ts = nowISO();
  const moved = state.tasks.filter((t) => t.sprintId === sprint.id).map((t) => normalizeTask({ ...t, sprintId: "", updatedAt: ts }));
  if (moved.length) await saveTasks(moved);
  await deleteSprint(sprint.id);
  await logEvent("sprint_deleted", { sprintId: sprint.id, movedToBacklog: moved.length });
  await reloadAndRerender();
  showToast("Sprint deleted.", { timeoutMs: 2200 });
}

async function noteSprintScopeChange({ fromSprintId, toSprintId, taskId }) {
  const active = getActiveSprint();
  if (!active) return;
  if (active.status !== "active") return;

  const sprint = state.sprintsById.get(active.id);
  if (!sprint) return;

  const committed = new Set(sprint.committedTaskIds || []);
  sprint.addedTaskIds = Array.isArray(sprint.addedTaskIds) ? sprint.addedTaskIds : [];
  sprint.removedTaskIds = Array.isArray(sprint.removedTaskIds) ? sprint.removedTaskIds : [];

  if (toSprintId === active.id && fromSprintId !== active.id) {
    if (!committed.has(taskId) && !sprint.addedTaskIds.includes(taskId)) sprint.addedTaskIds.push(taskId);
  }
  if (fromSprintId === active.id && toSprintId !== active.id) {
    if (!sprint.removedTaskIds.includes(taskId)) sprint.removedTaskIds.push(taskId);
  }

  await saveSprint({ ...sprint, updatedAt: nowISO() });
  await loadSprints();
}

async function addTaskToSprint(taskId, sprintId) {
  const task = state.tasksById.get(taskId);
  if (!task) return;
  const sprint = state.sprintsById.get(sprintId);
  if (!sprintId || !sprint) {
    showToast("Select a sprint to add the issue.", { kind: "error" });
    return;
  }
  if (sprint.status === "completed") {
    showToast("Cannot add issues to a completed sprint.", { kind: "error" });
    return;
  }
  const ts = nowISO();
  const updated = normalizeTask({ ...task, sprintId: sprint.id, updatedAt: ts });
  try {
    await saveTask(updated);
    await noteSprintScopeChange({ fromSprintId: task.sprintId || "", toSprintId: sprint.id, taskId });
    state.tasksById.set(updated.id, updated);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("task_sprint_changed", { taskId, from: task.sprintId || "", to: sprint.id });
    await recordActiveSprintSnapshot();
    render();
  } catch (err) {
    showToast(err?.message || "Failed to add to sprint.", { kind: "error" });
  }
}

async function removeTaskFromSprint(taskId) {
  const task = state.tasksById.get(taskId);
  if (!task) return;
  const ts = nowISO();
  const updated = normalizeTask({ ...task, sprintId: "", updatedAt: ts });
  try {
    await saveTask(updated);
    await noteSprintScopeChange({ fromSprintId: task.sprintId || "", toSprintId: "", taskId });
    state.tasksById.set(updated.id, updated);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("task_sprint_changed", { taskId, from: task.sprintId || "", to: "" });
    await recordActiveSprintSnapshot();
    render();
  } catch (err) {
    showToast(err?.message || "Failed to remove from sprint.", { kind: "error" });
  }
}

function sprintDisplayName(sprint) {
  if (!sprint) return "";
  const tag = sprint.status === "active" ? " (active)" : sprint.status === "completed" ? " (completed)" : "";
  return `${sprint.name || "Sprint"}${tag}`;
}

function isTaskDone(task) {
  return task && task.status === "done";
}

function unique(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function openSprintReportModal() {
  const modal = document.getElementById("sprintReportModal");
  const select = document.getElementById("reportSprintSelect");
  if (!modal || !select) return;
  const preferred = document.getElementById("activeSprintSelect")?.value || state.activeSprintId || state.sprints[0]?.id || "";
  renderSprintSelectOptions(select, preferred);
  openOverlayModal("sprintReportModal");
  renderSprintReport(select.value);
}

async function renderSprintReport(sprintId) {
  const body = document.getElementById("sprintReportBody");
  if (!body) return;
  const sprint = state.sprintsById.get(sprintId) || null;
  if (!sprint) {
    body.innerHTML = `<div class="muted">No sprint selected.</div>`;
    return;
  }

  const committed = unique(sprint.committedTaskIds);
  const added = unique(sprint.addedTaskIds);
  const removed = unique(sprint.removedTaskIds);

  const committedDone = committed.filter((id) => isTaskDone(state.tasksById.get(id))).length;
  const addedDone = added.filter((id) => isTaskDone(state.tasksById.get(id))).length;

  const sprintTasksNow = state.tasks.filter((t) => t.sprintId === sprint.id);
  const doneNow = sprintTasksNow.filter((t) => t.status === "done").length;
  const remainingNow = sprintTasksNow.filter((t) => t.status !== "done").length;

  const snapshots = await getSprintSnapshots(sprint.id);
  const snapRows =
    snapshots.length === 0
      ? `<div class="muted" style="font-size:13px;">No burndown data yet (it records while a sprint is active).</div>`
      : snapshots
          .map((s) => {
            const pct = s.total ? Math.round((s.remaining / Math.max(1, s.total)) * 100) : 0;
            return `
              <div class="list-item">
                <div class="list-item-left">
                  <div class="list-item-text">${escapeText(s.date)}</div>
                </div>
                <div class="muted">Remaining: ${s.remaining} / ${s.total} (${pct}%)</div>
              </div>
            `;
          })
          .join("");

  body.innerHTML = `
    <div class="section">
      <div class="section-title">Sprint</div>
      <div class="list">
        <div class="list-item"><div class="list-item-left"><div class="list-item-text">${escapeText(
          sprintDisplayName(sprint),
        )}</div></div><div class="muted">${escapeText(formatSprintRange(sprint))}</div></div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Report</div>
      <div class="list">
        <div class="list-item"><div class="list-item-left"><div class="list-item-text">Committed at start</div></div><div class="muted">${committed.length}</div></div>
        <div class="list-item"><div class="list-item-left"><div class="list-item-text">Committed completed</div></div><div class="muted">${committedDone}</div></div>
        <div class="list-item"><div class="list-item-left"><div class="list-item-text">Added during sprint</div></div><div class="muted">${added.length}</div></div>
        <div class="list-item"><div class="list-item-left"><div class="list-item-text">Added completed</div></div><div class="muted">${addedDone}</div></div>
        <div class="list-item"><div class="list-item-left"><div class="list-item-text">Removed from sprint</div></div><div class="muted">${removed.length}</div></div>
        <div class="list-item"><div class="list-item-left"><div class="list-item-text">Now in sprint</div></div><div class="muted">${sprintTasksNow.length} (done ${doneNow}, remaining ${remainingNow})</div></div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Burndown</div>
      <div class="list">
        ${snapRows}
      </div>
    </div>
  `;
}

async function onBulkMove() {
  const target = document.getElementById("bulkMoveStatus")?.value;
  const selected = [...state.bulk.selected];
  if (!target || !selected.length) return;

  const exclude = new Set(selected);
  const limit = wipLimitFor(target);
  if (limit) {
    const count = state.tasks.filter((t) => t.status === target && !exclude.has(t.id)).length;
    if (count + selected.length > limit) {
      showToast(`WIP limit reached for ${COLUMN_LABELS[target]}.`, { kind: "error" });
      return;
    }
  }

  const before = selected.map((id) => ({ ...state.tasksById.get(id) })).filter(Boolean);
  const ts = nowISO();
  const updates = before.map((t, idx) =>
    normalizeTask({
      ...t,
      status: target,
      order: nextOrderForStatus(target) + idx,
      updatedAt: ts,
      doneAt: target === "done" ? (t.doneAt || ts) : t.doneAt || "",
    }),
  );

  try {
    await saveTasks(updates);
    for (const t of updates) state.tasksById.set(t.id, t);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("bulk_move", { count: updates.length, to: target });
    state.undo = { type: "restore_tasks", tasks: before };
    showToast("Moved.", { actions: [{ label: "Undo", onClick: () => undoLast() }], timeoutMs: 7000 });
    state.bulk.selected.clear();
    renderBulkBar();
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Bulk move failed.", { kind: "error" });
  }
}

async function onBulkDelete() {
  const selected = [...state.bulk.selected];
  if (!selected.length) return;
  if (!confirm(`Delete ${selected.length} tasks?`)) return;
  const before = selected.map((id) => ({ ...state.tasksById.get(id) })).filter(Boolean);
  try {
    await Promise.all(selected.map((id) => deleteTask(id)));
    for (const id of selected) state.tasksById.delete(id);
    state.tasks = [...state.tasksById.values()].sort(byOrderThenDate);
    await logEvent("bulk_delete", { count: selected.length });
    state.undo = { type: "restore_tasks", tasks: before };
    showToast("Deleted.", { actions: [{ label: "Undo", onClick: () => undoLast() }], timeoutMs: 8000 });
    state.bulk.selected.clear();
    renderBulkBar();
    renderColumns();
  } catch (err) {
    showToast(err?.message || "Bulk delete failed.", { kind: "error" });
  }
}

async function onNewBoard() {
  const name = prompt("Board name:", "New Board");
  if (!name) return;
  const board = await createBoard(name);
  state.activeBoardId = board.id;
  await logEvent("board_created", { boardId: board.id });
  await reloadAndRerender();
  showToast("Board created.", { timeoutMs: 2200 });
}

async function onRenameBoard() {
  const board = state.boards.find((b) => b.id === state.activeBoardId);
  if (!board) return;
  const name = prompt("Rename board:", board.name);
  if (!name) return;
  await renameBoard(board.id, name);
  await logEvent("board_renamed", { boardId: board.id });
  await reloadAndRerender();
}

async function onDeleteBoard() {
  const board = state.boards.find((b) => b.id === state.activeBoardId);
  if (!board) return;
  if (!confirm(`Delete board "${board.name}" and all its tasks?`)) return;
  await removeBoard(board.id);
  await logEvent("board_deleted", { boardId: board.id });
  await reloadAndRerender();
}

async function onBoardSelectChange(e) {
  const id = e.target.value;
  state.activeBoardId = id;
  await setActiveBoardId(id);
  await reloadAndRerender();
}

function wireEvents() {
  el("newBoardBtn").addEventListener("click", onNewBoard);
  el("renameBoardBtn").addEventListener("click", onRenameBoard);
  el("deleteBoardBtn").addEventListener("click", onDeleteBoard);
  el("boardSelect").addEventListener("change", onBoardSelectChange);
  el("themeToggle").addEventListener("click", async () => {
    await toggleTheme();
  });

  document.getElementById("viewMode")?.addEventListener("change", (e) => onViewModeChange(e.target.value));

  document.getElementById("quickAddBtn")?.addEventListener("click", onQuickAdd);
  document.getElementById("quickAddTitle")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onQuickAdd();
    }
  });

  document.getElementById("searchInput")?.addEventListener("input", (e) => {
    state.filter.search = e.target.value || "";
    renderColumns();
  });

  document.getElementById("priorityFilter")?.addEventListener("change", (e) => {
    state.filter.priority = e.target.value || "";
    renderColumns();
  });

  document.getElementById("groupBy")?.addEventListener("change", (e) => {
    onGroupByChange(e.target.value);
  });

  document.getElementById("bulkToggleBtn")?.addEventListener("click", () => setBulkEnabled(!state.bulk.enabled));
  document.getElementById("bulkClearBtn")?.addEventListener("click", () => {
    state.bulk.selected.clear();
    renderBulkBar();
    renderColumns();
  });
  document.getElementById("bulkMoveBtn")?.addEventListener("click", onBulkMove);
  document.getElementById("bulkDeleteBtn")?.addEventListener("click", onBulkDelete);

  document.getElementById("exportBtn")?.addEventListener("click", onExportBoard);
  document.getElementById("importBtn")?.addEventListener("click", () => document.getElementById("importFileInput")?.click());
  document.getElementById("importFileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await onImportFile(file);
  });
  document.getElementById("resetBoardBtn")?.addEventListener("click", onResetBoard);
  document.getElementById("boardSettingsBtn")?.addEventListener("click", openSettingsModal);
  document.getElementById("insightsBtn")?.addEventListener("click", openInsightsModal);
  document.getElementById("epicsBtn")?.addEventListener("click", openEpicsModal);
  document.getElementById("newSprintBtn")?.addEventListener("click", () => {
    const name = document.getElementById("sprintName");
    const sd = document.getElementById("sprintStartDate");
    const ed = document.getElementById("sprintEndDate");
    if (name) name.value = `Sprint ${todayDate()}`;
    if (sd) sd.value = "";
    if (ed) ed.value = "";
    openOverlayModal("sprintModal");
  });
  document.getElementById("closeSprintBtn")?.addEventListener("click", () => closeOverlayModal("sprintModal", { force: true }));
  document.getElementById("sprintForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("sprintName")?.value || "";
    const startDate = document.getElementById("sprintStartDate")?.value || "";
    const endDate = document.getElementById("sprintEndDate")?.value || "";
    const sprint = await createSprint({ name, startDate, endDate });
    if (!sprint) return;
    closeOverlayModal("sprintModal", { force: true });
    await reloadAndRerender();
    showToast("Sprint created.", { timeoutMs: 2200 });
  });

  document.getElementById("activeSprintSelect")?.addEventListener("change", () => {
    renderScrumControls();
    renderScrumBacklog();
  });
  document.getElementById("startSprintBtn")?.addEventListener("click", async () => {
    const id = document.getElementById("activeSprintSelect")?.value || "";
    if (!id) return;
    await startSprint(id);
  });
  document.getElementById("completeSprintBtn")?.addEventListener("click", completeActiveSprint);
  document.getElementById("sprintReportBtn")?.addEventListener("click", () => openSprintReportModal());
  document.getElementById("newBacklogIssueBtn")?.addEventListener("click", () =>
    openTaskModal({ mode: "new", initialStatus: "todo", initialSprintId: "" }),
  );
  document.getElementById("closeSprintReportBtn")?.addEventListener("click", () =>
    closeOverlayModal("sprintReportModal", { force: true }),
  );
  document.getElementById("reportSprintSelect")?.addEventListener("change", (e) => {
    const id = e.target.value;
    renderSprintReport(id);
  });

  document.getElementById("closeSettingsBtn")?.addEventListener("click", () => closeOverlayModal("settingsModal", { force: true }));
  document.getElementById("settingsForm")?.addEventListener("submit", onSaveSettings);
  document.getElementById("closeInsightsBtn")?.addEventListener("click", () => closeOverlayModal("insightsModal", { force: true }));
  document.getElementById("closeEpicsBtn")?.addEventListener("click", () => closeOverlayModal("epicsModal", { force: true }));

  document.getElementById("epicCreateBtn")?.addEventListener("click", async () => {
    const input = document.getElementById("epicNewName");
    if (!input) return;
    const epic = await createEpicFromName(input.value);
    if (!epic) return;
    input.value = "";
    renderEpicsList();
    showToast("Epic created.", { timeoutMs: 2200 });
  });

  document.getElementById("refreshBtn")?.addEventListener("click", () => {
    state.updateRequested = true;
    if (state.swRegistration?.waiting) state.swRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
    else location.reload();
  });

  el("closeModalBtn").addEventListener("click", () => closeModal());
  el("modalBackdrop").addEventListener("click", () => {
    if (!el("taskModal").hidden) closeModal();
    else if (!el("settingsModal").hidden) closeOverlayModal("settingsModal", { force: true });
    else if (!el("insightsModal").hidden) closeOverlayModal("insightsModal", { force: true });
    else if (!el("epicsModal").hidden) closeOverlayModal("epicsModal", { force: true });
    else if (!el("sprintModal").hidden) closeOverlayModal("sprintModal", { force: true });
    else if (!el("sprintReportModal").hidden) closeOverlayModal("sprintReportModal", { force: true });
  });
  el("taskForm").addEventListener("submit", onSaveTask);
  el("deleteTaskBtn").addEventListener("click", onDeleteTask);
  document.getElementById("duplicateTaskBtn")?.addEventListener("click", onDuplicateTask);
  document.getElementById("moveLeftBtn")?.addEventListener("click", () => onMoveLeftRight("left"));
  document.getElementById("moveRightBtn")?.addEventListener("click", () => onMoveLeftRight("right"));
  document.getElementById("newEpicBtn")?.addEventListener("click", async () => {
    const name = prompt("New epic name:", "Epic");
    if (!name) return;
    const epic = await createEpicFromName(name);
    if (!epic) return;
    const select = document.getElementById("taskEpic");
    fillEpicOptions(select, epic.id);
    if (select) select.value = epic.id;
    state.modal.dirty = true;
    showToast("Epic created.", { timeoutMs: 2200 });
  });

  document.getElementById("togglePreviewBtn")?.addEventListener("click", () => {
    state.modal.preview = !state.modal.preview;
    const preview = document.getElementById("mdPreview");
    if (!preview) return;
    preview.hidden = !state.modal.preview;
    const btn = document.getElementById("togglePreviewBtn");
    if (btn) btn.textContent = state.modal.preview ? "Edit" : "Preview";
    if (state.modal.preview) preview.innerHTML = renderMarkdown(el("taskDescription").value || "");
  });
  el("taskDescription").addEventListener("input", () => {
    if (!state.modal.preview) return;
    const preview = document.getElementById("mdPreview");
    if (preview) preview.innerHTML = renderMarkdown(el("taskDescription").value || "");
  });

  document.getElementById("checklistAddBtn")?.addEventListener("click", () => {
    const input = document.getElementById("checklistNew");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const items = readChecklistFromUI();
    items.push({ id: makeId(), text, done: false });
    renderChecklist(items);
    input.value = "";
    state.modal.dirty = true;
  });

  document.getElementById("attachmentAddBtn")?.addEventListener("click", () => {
    const input = document.getElementById("attachmentNew");
    if (!input) return;
    const url = normalizeUrl(input.value);
    if (!url) {
      showToast("Invalid URL (http/https only).", { kind: "error" });
      return;
    }
    const urls = readAttachmentsFromUI();
    if (!urls.includes(url)) urls.push(url);
    renderAttachments(urls);
    input.value = "";
    state.modal.dirty = true;
  });

  [
    "taskTitle",
    "taskDescription",
    "taskStatus",
    "taskPriority",
    "taskColor",
    "taskAssignee",
    "taskDueDate",
    "taskEpic",
    "taskLabels",
    "taskSprint",
    "taskBlocked",
  ].forEach((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.addEventListener("input", () => (state.modal.dirty = true));
    node.addEventListener("change", () => (state.modal.dirty = true));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el("taskModal").hidden) closeModal();
    else if (!el("settingsModal").hidden) closeOverlayModal("settingsModal", { force: true });
    else if (!el("insightsModal").hidden) closeOverlayModal("insightsModal", { force: true });
    else if (!el("epicsModal").hidden) closeOverlayModal("epicsModal", { force: true });
    else if (!el("sprintModal").hidden) closeOverlayModal("sprintModal", { force: true });
    else if (!el("sprintReportModal").hidden) closeOverlayModal("sprintReportModal", { force: true });
  });

  const onAddClick = (e) => {
    const btn = e.target.closest(".add-task-btn");
    if (!btn) return;
    openTaskModal({
      mode: "new",
      initialStatus: btn.dataset.status,
      initialSprintId: btn.dataset.sprintId || "",
    });
  };
  el("columns").addEventListener("click", onAddClick);
  document.getElementById("sprintColumns")?.addEventListener("click", onAddClick);
}

async function registerServiceWorker() {
  const banner = document.getElementById("updateBanner");
  const showBanner = (show) => {
    if (banner) banner.hidden = !show;
  };

  if (!("serviceWorker" in navigator)) return null;
  const isLocalhost =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]";
  if (isLocalhost) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    showBanner(false);
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register("./sw.js");
    await reg.update();

    if (reg.waiting) showBanner(true);
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          showBanner(true);
        }
      });
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (state.updateRequested) location.reload();
    });

    return reg;
  } catch {
    return null;
  }
}

async function main() {
  await initDB();
  await initTheme();
  await loadBoardsAndActive();
  await loadTasks();
  await loadEpics();
  await loadSprints();
  wireEvents();
  renderBoardSelect();
  const groupBy = document.getElementById("groupBy");
  if (groupBy) groupBy.value = state.filter.groupBy;
  const viewMode = document.getElementById("viewMode");
  if (viewMode) viewMode.value = state.viewMode;
  syncViewModeUi();
  renderBulkBar();
  render();
  state.swRegistration = await registerServiceWorker();
}

main().catch((err) => {
  console.error(err);
  try {
    showToast(err?.message || "App failed to start.", { kind: "error", timeoutMs: 12000 });
  } catch {}
  try {
    alert(err?.message || "App failed to start. See console for details.");
  } catch {}
});
