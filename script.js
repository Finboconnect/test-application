import {
  addEvent,
  deleteTask,
  deleteTasksByBoardId,
  getBoards,
  getEvents,
  getTasks,
  initDB,
  makeId,
  saveTask,
  saveTasks,
} from "./db.js?v=2026-05-22-3";
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
} from "./boards.js?v=2026-05-22-3";
import { initTheme } from "./theme.js?v=2026-05-22-3";

const state = {
  boards: [],
  activeBoardId: null,
  activeBoard: null,
  tasks: [],
  tasksById: new Map(),
  draggingEl: null,
  filter: { search: "", priority: "", groupBy: "none", assignee: "" },
  bulk: { enabled: false, selected: new Set() },
  modal: { openId: null, dirty: false, preview: false, focusTrapCleanup: null },
  undo: null,
  swRegistration: null,
  updateRequested: false,
  activePage: "board",
};

function nowISO() {
  return new Date().toISOString();
}

const APP_VERSION = "2026-05-22-3";

const PAGE_LABELS = {
  board: "Board",
  backlog: "Backlog",
  roadmap: "Roadmap",
  reports: "Reports",
  issues: "Issues",
  code: "Code",
  releases: "Releases",
  components: "Components",
};

const VALID_PAGES = new Set(Object.keys(PAGE_LABELS));

const AVATAR_PALETTE = [
  "#DE350B",
  "#FF5630",
  "#FF8B00",
  "#FFAB00",
  "#00875A",
  "#00B8D9",
  "#0052CC",
  "#5243AA",
  "#6554C0",
  "#42526E",
];

function hashStringInt(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function issueKeyFor(task) {
  const num = (hashStringInt(task.id) % 9999) + 1;
  return `KAN-${num}`;
}

function avatarColorFor(name) {
  return AVATAR_PALETTE[hashStringInt(name) % AVATAR_PALETTE.length];
}

function initialsFor(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isOverdueDate(yyyy_mm_dd) {
  if (!yyyy_mm_dd) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${yyyy_mm_dd}T00:00:00`);
  return !Number.isNaN(d.getTime()) && d < today;
}

function priorityIconHtml(priority) {
  if (priority === "high") {
    return `<span class="priority-icon priority-high" title="Highest priority" aria-label="Highest priority">▲</span>`;
  }
  if (priority === "medium") {
    return `<span class="priority-icon priority-medium" title="Medium priority" aria-label="Medium priority">≡</span>`;
  }
  if (priority === "low") {
    return `<span class="priority-icon priority-low" title="Lowest priority" aria-label="Lowest priority">▼</span>`;
  }
  return "";
}

function syncBoardNameInChrome() {
  updatePageTitleForActivePage();
}

function updatePageTitleForActivePage() {
  const pageEl = document.getElementById("pageTitle");
  const crumbPage = document.getElementById("breadcrumbPageName");
  const boardName = state.activeBoard?.name || "Board";
  const pageLabel = PAGE_LABELS[state.activePage] || "Board";

  if (pageEl) {
    pageEl.textContent = state.activePage === "board" ? `${boardName} board` : pageLabel;
  }
  if (crumbPage) crumbPage.textContent = pageLabel;

  document.title =
    state.activePage === "board"
      ? `${boardName} board · Franklyn`
      : `${pageLabel} · Franklyn`;
}

function pageFromHash() {
  const h = (location.hash || "").replace(/^#\/?/, "").trim().toLowerCase();
  return VALID_PAGES.has(h) ? h : "board";
}

function setActivePage(name) {
  const page = VALID_PAGES.has(name) ? name : "board";
  state.activePage = page;
  document.body.dataset.page = page;

  document.querySelectorAll(".nav-item[data-page]").forEach((node) => {
    const isActive = node.dataset.page === page;
    node.classList.toggle("active", isActive);
    if (isActive) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });

  updatePageTitleForActivePage();

  const columns = document.getElementById("columns");
  const pageContent = document.getElementById("pageContent");
  if (!columns || !pageContent) return;

  if (page === "board") {
    columns.hidden = false;
    pageContent.hidden = true;
    pageContent.innerHTML = "";
    renderColumns();
    return;
  }

  columns.hidden = true;
  pageContent.hidden = false;
  renderActivePage();
}

function renderActivePage() {
  const root = document.getElementById("pageContent");
  if (!root) return;
  switch (state.activePage) {
    case "backlog":
      root.innerHTML = renderIssueListPage({
        title: "Backlog",
        subtitle: "All issues, grouped by status",
      });
      wireIssueListPage(root);
      break;
    case "issues":
      root.innerHTML = renderIssueListPage({
        title: "Issues",
        subtitle: "Search and inspect every issue in this project",
      });
      wireIssueListPage(root);
      break;
    case "roadmap":
      root.innerHTML = renderRoadmapPage();
      wireRoadmapPage(root);
      break;
    case "reports":
      root.innerHTML = renderReportsPage();
      break;
    case "code":
      root.innerHTML = renderEmptyState({
        title: "Connect your code",
        body: "Link a repository to see commits, branches and pull requests next to your issues.",
        cta: "Connect repository",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/></svg>',
      });
      break;
    case "releases":
      root.innerHTML = renderEmptyState({
        title: "Plan your first release",
        body: "Group completed issues into versions to track what shipped, and when.",
        cta: "Create version",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12l-7 7L4 11V4h7z"/><circle cx="9" cy="9" r="1.5"/></svg>',
      });
      break;
    case "components":
      root.innerHTML = renderEmptyState({
        title: "Organise your project with components",
        body: "Break your project into smaller pieces such as Frontend, API, Mobile to assign issues more clearly.",
        cta: "Add component",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 3v9"/><path d="M4 7.5l8 4.5 8-4.5"/></svg>',
      });
      break;
    default:
      root.innerHTML = "";
  }
}

function avatarHtmlFor(task) {
  const assignee = (task.assignee || "").trim();
  if (!assignee) {
    return `<span class="assignee-avatar unassigned" title="Unassigned" aria-label="Unassigned">?</span>`;
  }
  return `<span class="assignee-avatar" style="background:${escapeText(avatarColorFor(assignee))}" title="${escapeText(assignee)}" aria-label="${escapeText(assignee)}">${escapeText(initialsFor(assignee))}</span>`;
}

function statusLozenge(status) {
  const label = COLUMN_LABELS[status] || status;
  return `<span class="lozenge lz-${escapeText(status)}">${escapeText(label)}</span>`;
}

function priorityCellHtml(priority) {
  const icon = priorityIconHtml(priority);
  return icon || `<span class="muted" style="font-size:12px;">—</span>`;
}

function issueRowHtml(task) {
  const typeIcon = task.blocked
    ? `<span class="issue-type-icon issue-type-bug" title="Bug">!</span>`
    : `<span class="issue-type-icon issue-type-task" title="Task">✓</span>`;
  const due = task.dueDate ? String(task.dueDate).slice(0, 10) : "";
  const dueClass = due && isOverdueDate(due) ? "is-overdue" : "";
  const assignee = (task.assignee || "").trim();
  return `
    <tr data-task-id="${escapeText(task.id)}">
      <td class="col-type">${typeIcon}</td>
      <td class="col-key"><span class="issue-key">${escapeText(issueKeyFor(task))}</span></td>
      <td class="col-summary">${escapeText(task.title || "Untitled task")}</td>
      <td class="col-status">${statusLozenge(task.status)}</td>
      <td class="col-priority">${priorityCellHtml(task.priority)}</td>
      <td class="col-assignee">
        <span class="assignee-row">
          ${avatarHtmlFor(task)}
          <span class="assignee-name">${escapeText(assignee || "Unassigned")}</span>
        </span>
      </td>
      <td class="col-due ${dueClass}">${escapeText(due || "—")}</td>
    </tr>
  `;
}

function renderIssueListPage({ title, subtitle }) {
  const tasks = [...state.tasks];
  const tableBody = tasks.length
    ? tasks.map(issueRowHtml).join("")
    : `<tr><td colspan="7" style="text-align:center; padding:32px; color:var(--muted);">No issues yet. Create one from the Board.</td></tr>`;
  return `
    <div class="page-toolbar">
      <input class="input" type="search" id="pageSearch" placeholder="Search ${escapeText(title.toLowerCase())}…" />
      <select class="select" id="pageStatusFilter">
        <option value="">All statuses</option>
        ${COLUMN_IDS.map((c) => `<option value="${escapeText(c)}">${escapeText(COLUMN_LABELS[c])}</option>`).join("")}
      </select>
      <span class="muted" style="margin-left:auto; font-size:12px;">${escapeText(subtitle)}</span>
    </div>
    <div class="issue-table">
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Key</th>
            <th>Summary</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Assignee</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody id="issueTableBody">${tableBody}</tbody>
      </table>
    </div>
  `;
}

function wireIssueListPage(root) {
  const search = root.querySelector("#pageSearch");
  const statusFilter = root.querySelector("#pageStatusFilter");
  const tbody = root.querySelector("#issueTableBody");

  function applyFilters() {
    const q = (search?.value || "").trim().toLowerCase();
    const s = statusFilter?.value || "";
    const rows = state.tasks
      .filter((t) => (s ? t.status === s : true))
      .filter((t) => {
        if (!q) return true;
        const hay = [
          t.title || "",
          (t.labels || []).join(" "),
          t.assignee || "",
          issueKeyFor(t),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    tbody.innerHTML = rows.length
      ? rows.map(issueRowHtml).join("")
      : `<tr><td colspan="7" style="text-align:center; padding:32px; color:var(--muted);">No issues match your filters.</td></tr>`;
    bindRowClicks();
  }

  function bindRowClicks() {
    tbody.querySelectorAll("tr[data-task-id]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const task = state.tasksById.get(tr.dataset.taskId);
        if (task) openTaskModal({ mode: "edit", task });
      });
    });
  }

  search?.addEventListener("input", applyFilters);
  statusFilter?.addEventListener("change", applyFilters);
  bindRowClicks();
}

function renderRoadmapPage() {
  const dated = state.tasks
    .filter((t) => t.dueDate)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));

  if (!dated.length) {
    return renderEmptyState({
      title: "Plan your timeline",
      body: "Add a due date to your issues and they will appear here, grouped by month.",
      cta: "Go to Board",
      ctaHref: "#/board",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="3" rx="1.5"/><rect x="7" y="11" width="14" height="3" rx="1.5"/><rect x="5" y="16" width="11" height="3" rx="1.5"/></svg>',
    });
  }

  const byMonth = new Map();
  for (const t of dated) {
    const d = new Date(`${t.dueDate}T00:00:00`);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(t);
  }

  const monthFormatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

  let html = "";
  for (const [key, items] of byMonth) {
    const [y, m] = key.split("-").map(Number);
    const label = monthFormatter.format(new Date(y, m - 1, 1));
    html += `
      <div class="roadmap-month">
        <div class="roadmap-month-title">${escapeText(label)}</div>
        ${items
          .map(
            (t) => `
          <div class="roadmap-row" data-task-id="${escapeText(t.id)}">
            <div class="roadmap-date">${escapeText(t.dueDate)}</div>
            <div>
              <div class="roadmap-summary">${escapeText(t.title || "Untitled task")}</div>
              <div class="muted" style="font-size:12px; margin-top:2px;">${escapeText(issueKeyFor(t))} · ${escapeText(t.assignee || "Unassigned")}</div>
            </div>
            <div>${statusLozenge(t.status)}</div>
          </div>
        `,
          )
          .join("")}
      </div>
    `;
  }
  return html;
}

function wireRoadmapPage(root) {
  root.querySelectorAll(".roadmap-row[data-task-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const task = state.tasksById.get(row.dataset.taskId);
      if (task) openTaskModal({ mode: "edit", task });
    });
  });
}

function renderReportsPage() {
  const total = state.tasks.length;
  const byStatus = Object.fromEntries(COLUMN_IDS.map((c) => [c, 0]));
  const byPriority = { high: 0, medium: 0, low: 0, none: 0 };
  let blocked = 0;
  let overdue = 0;
  let unassigned = 0;

  for (const t of state.tasks) {
    if (t.status in byStatus) byStatus[t.status]++;
    const p = t.priority || "none";
    if (p in byPriority) byPriority[p]++;
    if (t.blocked) blocked++;
    if (t.dueDate && isOverdueDate(t.dueDate) && t.status !== "done") overdue++;
    if (!(t.assignee || "").trim()) unassigned++;
  }

  const done = byStatus.done || 0;
  const completion = total ? Math.round((done / total) * 100) : 0;
  const maxStatus = Math.max(1, ...Object.values(byStatus));
  const maxPriority = Math.max(1, ...Object.values(byPriority));

  const statusBars = COLUMN_IDS.map((c) => {
    const count = byStatus[c] || 0;
    const width = Math.round((count / maxStatus) * 100);
    return `
      <div class="bar-row">
        <div class="bar-label">${escapeText(COLUMN_LABELS[c])}</div>
        <div class="bar-track"><div class="bar-fill bar-${escapeText(c)}" style="width:${width}%"></div></div>
        <div class="bar-count">${count}</div>
      </div>
    `;
  }).join("");

  const priorityBars = ["high", "medium", "low", "none"]
    .map((p) => {
      const count = byPriority[p];
      const width = Math.round((count / maxPriority) * 100);
      const label = p === "none" ? "None" : p === "high" ? "Highest" : p === "medium" ? "Medium" : "Lowest";
      return `
        <div class="bar-row">
          <div class="bar-label">${escapeText(label)}</div>
          <div class="bar-track"><div class="bar-fill bar-${escapeText(p)}" style="width:${width}%"></div></div>
          <div class="bar-count">${count}</div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Total issues</div>
        <div class="stat-value">${total}</div>
        <div class="stat-sub">In this board</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Completed</div>
        <div class="stat-value">${done}</div>
        <div class="stat-sub">${completion}% completion</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Overdue</div>
        <div class="stat-value">${overdue}</div>
        <div class="stat-sub">Past due, not done</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Blocked</div>
        <div class="stat-value">${blocked}</div>
        <div class="stat-sub">Flagged issues</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Unassigned</div>
        <div class="stat-value">${unassigned}</div>
        <div class="stat-sub">Need an owner</div>
      </div>
    </div>

    <div>
      <h3 class="page-section-title" style="margin-bottom:8px;">Issues by status</h3>
      <div class="bar-list">${statusBars}</div>
    </div>

    <div>
      <h3 class="page-section-title" style="margin-bottom:8px;">Issues by priority</h3>
      <div class="bar-list">${priorityBars}</div>
    </div>
  `;
}

function renderEmptyState({ title, body, cta, ctaHref, icon }) {
  const ctaHtml = cta
    ? ctaHref
      ? `<a class="btn btn-primary" href="${escapeText(ctaHref)}">${escapeText(cta)}</a>`
      : `<button class="btn btn-primary" type="button">${escapeText(cta)}</button>`
    : "";
  return `
    <div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true">${icon || ""}</div>
      <div class="empty-state-title">${escapeText(title)}</div>
      <div class="empty-state-body">${escapeText(body)}</div>
      ${ctaHtml}
    </div>
  `;
}

function setupRouter() {
  window.addEventListener("hashchange", () => setActivePage(pageFromHash()));
  setActivePage(pageFromHash());
}

function renderTodayPill() {
  const text = document.getElementById("todayPillText");
  if (!text) return;
  const today = new Date();
  text.textContent = today.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function renderSprintChip() {
  const chip = document.getElementById("sprintChip");
  const statusText = document.getElementById("sprintStatusText");
  if (!chip || !statusText) return;

  chip.classList.remove("is-warning", "is-overdue");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const futureDates = state.tasks
    .filter((t) => t.dueDate && t.status !== "done")
    .map((t) => new Date(`${t.dueDate}T00:00:00`))
    .filter((d) => !Number.isNaN(d.getTime()));

  if (!futureDates.length) {
    statusText.textContent = "Active";
    return;
  }

  futureDates.sort((a, b) => a - b);
  const earliest = futureDates[0];
  const diffMs = earliest - today;
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (days < 0) {
    chip.classList.add("is-overdue");
    statusText.textContent = `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;
  } else if (days === 0) {
    chip.classList.add("is-warning");
    statusText.textContent = "Due today";
  } else if (days <= 3) {
    chip.classList.add("is-warning");
    statusText.textContent = `${days} day${days === 1 ? "" : "s"} remaining`;
  } else {
    statusText.textContent = `${days} days remaining`;
  }
}

function renderAssigneeGroup() {
  const group = document.getElementById("assigneeGroup");
  const stack = document.getElementById("assigneeStack");
  const clearBtn = document.getElementById("assigneeClear");
  if (!group || !stack || !clearBtn) return;

  const counts = new Map();
  for (const t of state.tasks) {
    const a = (t.assignee || "").trim();
    if (!a) continue;
    counts.set(a, (counts.get(a) || 0) + 1);
  }

  if (!counts.size) {
    group.hidden = true;
    stack.innerHTML = "";
    return;
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const visible = sorted.slice(0, 5);
  const rest = sorted.length - visible.length;

  group.hidden = false;
  const activeAssignee = state.filter.assignee || "";

  stack.innerHTML =
    visible
      .map(([name, n]) => {
        const isActive = name.toLowerCase() === activeAssignee.toLowerCase();
        return `<button class="assignee-avatar ${isActive ? "is-active" : ""}" type="button" style="background:${escapeText(avatarColorFor(name))}" title="${escapeText(name)} · ${n} issue${n === 1 ? "" : "s"}" aria-label="Filter by ${escapeText(name)}" data-assignee="${escapeText(name)}">${escapeText(initialsFor(name))}</button>`;
      })
      .join("") + (rest > 0 ? `<span class="assignee-more" title="${rest} more">+${rest}</span>` : "");

  stack.querySelectorAll("[data-assignee]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.assignee || "";
      state.filter.assignee = state.filter.assignee === name ? "" : name;
      renderAssigneeGroup();
      renderColumns();
    });
  });

  clearBtn.hidden = !activeAssignee;
  clearBtn.onclick = () => {
    state.filter.assignee = "";
    renderAssigneeGroup();
    renderColumns();
  };
}

function renderBoardMeta() {
  if (state.activePage !== "board") return;
  renderSprintChip();
  renderAssigneeGroup();
}

function showWelcomeIfEmpty() {
  if (state.activePage !== "board") return;
  const columns = document.getElementById("columns");
  if (!columns) return;
  if (state.tasks.length > 0) return;

  columns.innerHTML = `
    <div class="welcome-card" style="grid-column: 1 / -1;">
      <div class="welcome-greeting">Welcome, Franklyn</div>
      <div class="welcome-title">Your board is ready.</div>
      <div class="welcome-body">
        This is your personal Jira-style workspace. Drop a quick task above, or open the create dialog to add details like priority, assignee, and a due date.
        Your data stays on this device — IndexedDB powered, fully offline.
      </div>
      <div class="welcome-actions">
        <button class="btn btn-primary" type="button" id="welcomeCreateBtn">+ Create your first issue</button>
        <a class="btn" href="#/backlog">Open backlog</a>
      </div>
    </div>
  `;

  const createBtn = document.getElementById("welcomeCreateBtn");
  if (createBtn) {
    createBtn.addEventListener("click", () => {
      const input = document.getElementById("quickAddTitle");
      if (input) input.focus();
    });
  }
}

function wireUserMenu() {
  const btn = document.getElementById("userAvatarBtn");
  const menu = document.getElementById("userMenu");
  if (!btn || !menu) return;

  function close() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onEsc, true);
  }

  function open() {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutside, true);
    document.addEventListener("keydown", onEsc, true);
  }

  function onOutside(e) {
    if (!menu.contains(e.target) && e.target !== btn) close();
  }
  function onEsc(e) {
    if (e.key === "Escape") {
      close();
      btn.focus();
    }
  }

  btn.addEventListener("click", () => {
    if (menu.hidden) open();
    else close();
  });

  menu.querySelectorAll(".user-menu-item[data-action]").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      close();
      if (action === "logout") {
        showToast("Logged out (demo)", { timeoutMs: 3000 });
      } else if (action === "profile") {
        showToast("Profile coming soon", { timeoutMs: 3000 });
      } else if (action === "notifications") {
        showToast("You're all caught up", { timeoutMs: 3000 });
      } else if (action === "theme") {
        showToast("Appearance: Light only", { timeoutMs: 3000 });
      }
    });
  });
}

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
  const count = state.tasks.filter((t) => t.status === status && t.id !== excludingTaskId).length;
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
  const timer = setTimeout(() => toast.remove(), timeoutMs);
  toast.addEventListener("mouseenter", () => clearTimeout(timer), { once: true });
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
  const af = (state.filter.assignee || "").trim().toLowerCase();
  return state.tasks.filter((t) => {
    if (pf === "high" || pf === "medium" || pf === "low") {
      if (t.priority !== pf) return false;
    } else if (pf === "none") {
      if ((t.priority || "") !== "") return false;
    }
    if (af) {
      const ta = (t.assignee || "").trim().toLowerCase();
      if (ta !== af) return false;
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
}

async function loadTasks() {
  state.tasks = (await getTasks(state.activeBoardId)).map(normalizeTask).sort(byOrderThenDate);
  state.tasksById = new Map(state.tasks.map((t) => [t.id, t]));
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
  syncBoardNameInChrome(state.activeBoard?.name || "Kanban");
}

function renderColumns() {
  const columnsRoot = el("columns");
  const tasks = filteredTasks();
  const counts = taskCounts(tasks);

  columnsRoot.innerHTML = COLUMN_IDS.map((status) => {
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
        <div class="task-list" role="list" data-status="${escapeText(status)}"></div>
      </section>
    `;
  }).join("");

  for (const status of COLUMN_IDS) {
    const list = columnsRoot.querySelector(`.task-list[data-status="${CSS.escape(status)}"]`);
    if (!list) continue;
    list.addEventListener("dragover", onDragOver);
    list.addEventListener("drop", onDrop);
    list.addEventListener("dragenter", (e) => {
      if (state.filter.groupBy !== "none") return;
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
  renderBoardMeta();
  showWelcomeIfEmpty();
}

function renderTasks() {
  const root = el("columns");
  const tasks = filteredTasks();
  for (const status of COLUMN_IDS) {
    const list = root.querySelector(`.task-list[data-status="${CSS.escape(status)}"]`);
    if (!list) continue;
    const columnTasks = tasks.filter((t) => t.status === status).sort(byOrderThenDate);

    if (state.filter.groupBy === "none") {
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
  const color = task.color || "#0052cc";
  const priority = task.priority || "";
  const due = task.dueDate ? String(task.dueDate).slice(0, 10) : "";
  const labels = Array.isArray(task.labels) ? task.labels.slice(0, 4) : [];

  const desc = (task.description || "").trim().replace(/\s+/g, " ");
  const descHtml = desc ? `<div class="task-desc">${escapeText(desc.slice(0, 160))}</div>` : "";

  const labelChipsHtml = labels.length
    ? `<div class="task-labels">${labels
        .map((l) => `<span class="task-label">${escapeText(l)}</span>`)
        .join("")}</div>`
    : "";

  const dueChipHtml = due
    ? `<span class="task-due ${isOverdueDate(due) ? "is-overdue" : ""}" title="Due ${escapeText(due)}">${escapeText(due)}</span>`
    : "";
  const metaRowHtml = dueChipHtml ? `<div class="task-meta-row">${dueChipHtml}</div>` : "";

  const issueKey = issueKeyFor(task);
  const typeIconHtml = task.blocked
    ? `<span class="issue-type-icon issue-type-bug" title="Bug" aria-label="Bug">!</span>`
    : `<span class="issue-type-icon issue-type-task" title="Task" aria-label="Task">✓</span>`;
  const priorityHtml = priorityIconHtml(priority);

  const assignee = (task.assignee || "").trim();
  const avatarHtml = assignee
    ? `<span class="assignee-avatar" style="background:${escapeText(avatarColorFor(assignee))}" title="Assigned to ${escapeText(assignee)}" aria-label="Assigned to ${escapeText(assignee)}">${escapeText(initialsFor(assignee))}</span>`
    : `<span class="assignee-avatar unassigned" title="Unassigned" aria-label="Unassigned">?</span>`;

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
    )}" style="--card-accent:${escapeText(color)}">
      ${bulkCheck}
      <div class="task-actions">
        <button class="mini-btn" type="button" data-dir="left" aria-label="Move left">&lsaquo;</button>
        <button class="mini-btn" type="button" data-dir="right" aria-label="Move right">&rsaquo;</button>
      </div>
      <div class="task-title">${escapeText(task.title || "Untitled task")}</div>
      ${descHtml}
      ${labelChipsHtml}
      ${metaRowHtml}
      <div class="task-footer">
        <div class="task-footer-left">
          ${typeIconHtml}
          <span class="issue-key">${escapeText(issueKey)}</span>
          ${priorityHtml}
        </div>
        <div class="task-footer-right">
          ${avatarHtml}
        </div>
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

    renderColumns();
  } catch (err) {
    showToast(err?.message || "Move failed.", { kind: "error" });
  }
}

async function reorderWithinStatus(taskId, direction) {
  const task = state.tasksById.get(taskId);
  if (!task) return;
  const list = state.tasks
    .filter((t) => t.status === task.status)
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
  const card = e.currentTarget;
  state.draggingEl = card;
  card.classList.add("is-dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", card.dataset.taskId);
}

function onDragEnd() {
  if (state.draggingEl) state.draggingEl.classList.remove("is-dragging");
  state.draggingEl = null;
  document.querySelectorAll(".task-list").forEach((l) => {
    l.style.outline = "";
    l.style.outlineOffset = "";
  });
}

function onDragOver(e) {
  if (state.filter.groupBy !== "none" || state.bulk.enabled) return;
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
  await persistTaskPositionsFromDOM();
  await reloadAndRerender();
}

async function persistTaskPositionsFromDOM() {
  const root = el("columns");
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
      if (existing.status !== status || existing.order !== idx) {
        const ts = nowISO();
        updates.push(
          normalizeTask({
            ...existing,
            status,
            order: idx,
            updatedAt: ts,
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
    !el("taskModal").hidden || !el("settingsModal").hidden || !el("insightsModal").hidden;
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

function openTaskModal({ mode, task, initialStatus }) {
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

  fillStatusOptions(statusSelect);

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
  const tasks = state.tasks.filter((t) => t.status === status);
  const max = tasks.reduce((m, t) => Math.max(m, typeof t.order === "number" ? t.order : 0), -1);
  return max + 1;
}

async function onSaveTask(e) {
  e.preventDefault();
  const id = el("taskId").value.trim();
  const title = el("taskTitle").value.trim();
  const description = el("taskDescription").value || "";
  const status = el("taskStatus").value;
  const priority = el("taskPriority").value || "";
  const color = el("taskColor").value || "";
  const assignee = (document.getElementById("taskAssignee")?.value || "").trim();
  const dueRaw = document.getElementById("taskDueDate")?.value || "";
  const dueDate = dueRaw ? `${dueRaw}T00:00:00.000Z` : "";
  const labels = parseLabels(document.getElementById("taskLabels")?.value || "");
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

  const statusChanged = existing && existing.status !== status;

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
  renderBoardSelect();
  const groupBy = document.getElementById("groupBy");
  if (groupBy) groupBy.value = state.filter.groupBy;
  renderBulkBar();
  if (state.activePage === "board") {
    renderColumns();
  } else {
    renderActivePage();
    updatePageTitleForActivePage();
  }
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
          <textarea class="textarea" rows="2" data-policy="${escapeText(c)}" placeholder="Optional policy…">${escapeText(
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
          <div class="list-item"><div class="list-item-left"><div class="list-item-text">Average</div></div><div class="muted">${cycleMs.length ? formatDuration(avg) : "—"}</div></div>
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

  document.getElementById("closeSettingsBtn")?.addEventListener("click", () => closeOverlayModal("settingsModal", { force: true }));
  document.getElementById("settingsForm")?.addEventListener("submit", onSaveSettings);
  document.getElementById("closeInsightsBtn")?.addEventListener("click", () => closeOverlayModal("insightsModal", { force: true }));

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
  });
  el("taskForm").addEventListener("submit", onSaveTask);
  el("deleteTaskBtn").addEventListener("click", onDeleteTask);
  document.getElementById("duplicateTaskBtn")?.addEventListener("click", onDuplicateTask);
  document.getElementById("moveLeftBtn")?.addEventListener("click", () => onMoveLeftRight("left"));
  document.getElementById("moveRightBtn")?.addEventListener("click", () => onMoveLeftRight("right"));

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
    "taskLabels",
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
  });

  el("columns").addEventListener("click", (e) => {
    const btn = e.target.closest(".add-task-btn");
    if (!btn) return;
    openTaskModal({ mode: "new", initialStatus: btn.dataset.status });
  });
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
  wireEvents();
  wireUserMenu();
  renderTodayPill();
  renderBoardSelect();
  const groupBy = document.getElementById("groupBy");
  if (groupBy) groupBy.value = state.filter.groupBy;
  renderBulkBar();
  setupRouter();
  state.swRegistration = await registerServiceWorker();
}

main();
