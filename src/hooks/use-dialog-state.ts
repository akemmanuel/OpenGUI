import { useCallback, useState } from "react";
import { getErrorMessage } from "@/lib/utils";

export function useDialogError() {
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);
  const setUnknownError = useCallback(
    (err: unknown, fallback = "Operation failed") => setError(getErrorMessage(err, fallback)),
    [],
  );

  return { error, setError, clearError, setUnknownError };
}

export function useAsyncDialogOperation<TArgs extends unknown[]>(
  operation: (...args: TArgs) => Promise<void>,
) {
  const [loading, setLoading] = useState(false);

  const execute = useCallback(
    async (...args: TArgs) => {
      setLoading(true);
      try {
        await operation(...args);
      } finally {
        setLoading(false);
      }
    },
    [operation],
  );

  return { loading, execute };
}
