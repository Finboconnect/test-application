/*
 * Theme is locked to "light" (Jira blue + white).
 * The exports remain so existing imports don't break.
 */
export async function getTheme() {
  return "light";
}

export async function setTheme() {
  document.documentElement.dataset.theme = "light";
  return "light";
}

export async function initTheme() {
  document.documentElement.dataset.theme = "light";
  return "light";
}

export async function toggleTheme() {
  document.documentElement.dataset.theme = "light";
  return "light";
}
