import { useCallback, useState } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/utils";

export function useDialogError() {
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);
  const showError = useCallback((message: string | null) => {
    setError(null);
    if (message) toast.error(message);
  }, []);
  const setUnknownError = useCallback(
    (err: unknown, fallback = "Operation failed") => showError(getErrorMessage(err, fallback)),
    [showError],
  );

  return { error, setError: showError, clearError, setUnknownError };
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
