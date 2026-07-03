import { useEffect, useState } from "react";
import { getStoredModelMaxAgeMonths } from "@/components/model-selector-groups";
import { MAX_RECENT_MODELS, STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageParsed, storageSetJSON } from "@/lib/safe-storage";

export function useModelSelectorPreferences() {
  const [recentValues, setRecentValues] = useState<string[]>([]);
  const [favoriteValues, setFavoriteValues] = useState<Set<string>>(new Set());
  const [modelMaxAgeMonths, setModelMaxAgeMonths] = useState(() =>
    getStoredModelMaxAgeMonths(storageGet, STORAGE_KEYS.MODEL_MAX_AGE_MONTHS),
  );
  const [storageHydrated, setStorageHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const recentArr = storageParsed<unknown[]>(STORAGE_KEYS.RECENT_MODELS);
    if (Array.isArray(recentArr)) {
      setRecentValues(recentArr.filter((v): v is string => typeof v === "string"));
    }
    const favArr = storageParsed<unknown[]>(STORAGE_KEYS.FAVORITE_MODELS);
    if (Array.isArray(favArr)) {
      setFavoriteValues(new Set(favArr.filter((v): v is string => typeof v === "string")));
    }
    setStorageHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncModelMaxAge = () => {
      setModelMaxAgeMonths(
        getStoredModelMaxAgeMonths(storageGet, STORAGE_KEYS.MODEL_MAX_AGE_MONTHS),
      );
    };
    window.addEventListener("storage", syncModelMaxAge);
    window.addEventListener("model-max-age-months-changed", syncModelMaxAge);
    return () => {
      window.removeEventListener("storage", syncModelMaxAge);
      window.removeEventListener("model-max-age-months-changed", syncModelMaxAge);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !storageHydrated) return;
    storageSetJSON(STORAGE_KEYS.RECENT_MODELS, recentValues.slice(0, MAX_RECENT_MODELS));
  }, [recentValues, storageHydrated]);

  useEffect(() => {
    if (typeof window === "undefined" || !storageHydrated) return;
    storageSetJSON(STORAGE_KEYS.FAVORITE_MODELS, [...favoriteValues]);
  }, [favoriteValues, storageHydrated]);

  const recordRecentSelection = (value: string) => {
    setRecentValues((previous) => {
      const next = [value, ...previous.filter((v) => v !== value)];
      return next.slice(0, MAX_RECENT_MODELS);
    });
  };

  const toggleFavorite = (value: string) => {
    setFavoriteValues((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  return {
    recentValues,
    favoriteValues,
    modelMaxAgeMonths,
    recordRecentSelection,
    toggleFavorite,
  };
}
