// App-wide theme (dark phosphor / light paper), applied by overriding the
// design tokens on <html> (see theme.css). Per-machine convenience only, so
// localStorage is the right store; every read/write is wrapped because
// storage can be unavailable (and the app must simply stay dark then).
//
// The dashboard and the rail are separate windows sharing one localStorage:
// the `storage` event (which only fires in OTHER windows) keeps whichever
// window didn't make the change in sync.

export type Theme = "dark" | "light";

const STORAGE_KEY = "deskrecap.theme";

export function getTheme(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode etc. -- the theme still applies for this run */
  }
  applyTheme(theme);
}

export function initTheme(): void {
  applyTheme(getTheme());
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) applyTheme(e.newValue === "light" ? "light" : "dark");
  });
}
