import { getSetting, setSetting } from "./db.js?v=2026-01-09-2";

const THEME_KEY = "theme";

function applyTheme(theme) {
  const finalTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = finalTheme;
  return finalTheme;
}

export async function getTheme() {
  return (await getSetting(THEME_KEY)) || null;
}

export async function setTheme(theme) {
  const applied = applyTheme(theme);
  await setSetting(THEME_KEY, applied);
  return applied;
}

export async function initTheme() {
  const stored = await getTheme();
  if (stored) return applyTheme(stored);

  const prefersDark =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches;
  const initial = prefersDark ? "dark" : "light";
  await setSetting(THEME_KEY, initial);
  return applyTheme(initial);
}

export async function toggleTheme() {
  const current = document.documentElement.dataset.theme || (await getTheme()) || "light";
  return setTheme(current === "dark" ? "light" : "dark");
}
