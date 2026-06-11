import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/safe-storage";

export type ThemeMode = "dark" | "light" | "system";
/** Resolved actual theme (never "system") */
export type Theme = "dark" | "light";

const DEFAULT_CONTRAST = 50;
const DEFAULT_ACCENT_COLOR = "default";
const DEFAULT_CODE_FONT_SIZE = 13;

interface RGB {
  r: number;
  g: number;
  b: number;
}

function getStoredMode(): ThemeMode {
  const stored = storageGet(STORAGE_KEYS.THEME);
  if (stored === "dark" || stored === "light" || stored === "system") return stored;
  return "system";
}

function getStoredContrast(): number {
  const stored = storageGet(STORAGE_KEYS.CONTRAST);
  if (stored) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) return parsed;
  }
  return DEFAULT_CONTRAST;
}

function getStoredAccentColor(): string {
  const stored = storageGet(STORAGE_KEYS.ACCENT_COLOR);
  if (stored === "default") return "default";
  if (stored && /^#[0-9a-f]{6}$/i.test(stored)) return stored;
  return DEFAULT_ACCENT_COLOR;
}

function getStoredCodeFontSize(): number {
  const stored = storageGet(STORAGE_KEYS.CODE_FONT_SIZE);
  if (stored) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed >= 10 && parsed <= 20) return parsed;
  }
  return DEFAULT_CODE_FONT_SIZE;
}

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(mode: ThemeMode): Theme {
  if (mode === "system") return getSystemTheme();
  return mode;
}

function applyContrast(contrast: number, theme: Theme) {
  if (theme === "dark") {
    // contrast 0  → lighter bg (less contrast with text) = 0.20
    // contrast 50 → default                              = 0.145
    // contrast 100→ darker bg (more contrast with text)  = 0.08
    const bgL = 0.2 - (contrast / 100) * 0.12;
    const cardL = Math.min(bgL + 0.06, 0.269);
    document.documentElement.style.setProperty("--dynamic-bg-l", bgL.toFixed(3));
    document.documentElement.style.setProperty("--dynamic-card-l", cardL.toFixed(3));
  } else {
    // Light mode: contrast 0 → very slightly grey, contrast 50+ → pure white
    const bgL = Math.min(1, 0.94 + (contrast / 100) * 0.06);
    document.documentElement.style.setProperty("--dynamic-bg-l", bgL.toFixed(3));
    document.documentElement.style.setProperty("--dynamic-card-l", "1");
  }
}

function hexToRgb(hex: string): RGB {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function getReadableForeground({ r, g, b }: RGB) {
  const toLinear = (channel: number) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return luminance > 0.45 ? "oklch(0.145 0 0)" : "oklch(0.985 0 0)";
}

function applyAccentColor(color: string) {
  const root = document.documentElement;
  const dynamicVars = [
    "--dynamic-primary",
    "--dynamic-primary-foreground",
    "--dynamic-primary-rgb",
  ];

  if (color === "default") {
    // Remove custom tokens → CSS falls back to theme-native neutral values.
    for (const name of dynamicVars) root.style.removeProperty(name);
    return;
  }

  const rgb = hexToRgb(color);
  root.style.setProperty("--dynamic-primary", color);
  root.style.setProperty("--dynamic-primary-foreground", getReadableForeground(rgb));
  root.style.setProperty("--dynamic-primary-rgb", `${rgb.r} ${rgb.g} ${rgb.b}`);
}

function applyCodeFontSize(size: number) {
  document.documentElement.style.setProperty("--code-font-size", `${size}px`);
}

export function applyStoredAppearance() {
  applyTheme(getStoredMode(), getStoredContrast(), getStoredAccentColor(), getStoredCodeFontSize());
}

function applyTheme(mode: ThemeMode, contrast: number, accentColor: string, codeFontSize: number) {
  const resolved = resolveTheme(mode);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  applyContrast(contrast, resolved);
  applyAccentColor(accentColor);
  applyCodeFontSize(codeFontSize);
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(getStoredMode);
  const [contrast, setContrastState] = useState<number>(getStoredContrast);
  const [accentColor, setAccentColorState] = useState<string>(getStoredAccentColor);
  const [codeFontSize, setCodeFontSizeState] = useState<number>(getStoredCodeFontSize);

  useEffect(() => {
    applyTheme(mode, contrast, accentColor, codeFontSize);
  }, [mode, contrast, accentColor, codeFontSize]);

  // Follow system preference changes when mode is "system"
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system", contrast, accentColor, codeFontSize);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode, contrast, accentColor, codeFontSize]);

  const setTheme = useCallback((t: ThemeMode) => {
    storageSet(STORAGE_KEYS.THEME, t);
    setModeState(t);
  }, []);

  const setContrast = useCallback((c: number) => {
    storageSet(STORAGE_KEYS.CONTRAST, String(c));
    setContrastState(c);
  }, []);

  const setAccentColor = useCallback((color: string) => {
    if (color !== "default" && !/^#[0-9a-f]{6}$/i.test(color)) return;
    storageSet(STORAGE_KEYS.ACCENT_COLOR, color);
    setAccentColorState(color);
  }, []);

  const setCodeFontSize = useCallback((size: number) => {
    const clamped = Math.min(Math.max(size, 10), 20);
    storageSet(STORAGE_KEYS.CODE_FONT_SIZE, String(clamped));
    setCodeFontSizeState(clamped);
  }, []);

  // Resolved theme for consumers that need "dark" | "light"
  const theme = resolveTheme(mode);

  // Backward-compat toggle (dark ↔ light)
  const toggleTheme = useCallback(() => {
    setModeState((prev) => {
      const resolved = resolveTheme(prev);
      const next: ThemeMode = resolved === "dark" ? "light" : "dark";
      storageSet(STORAGE_KEYS.THEME, next);
      return next;
    });
  }, []);

  return {
    theme,
    mode,
    setTheme,
    toggleTheme,
    contrast,
    setContrast,
    accentColor,
    setAccentColor,
    codeFontSize,
    setCodeFontSize,
  } as const;
}
