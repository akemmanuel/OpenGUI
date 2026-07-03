import { useEffect, useState } from "react";
import { fetchHarnessInventoriesCached } from "@/lib/harness-inventory-cache";
import type { OpenGuiClient } from "@/protocol/client";
import type { HarnessInventory } from "@/types/electron";

export function useModelSelectorInventories(open: boolean, client: OpenGuiClient) {
  const [inventories, setInventories] = useState<HarnessInventory[]>([]);
  const [inventoriesReady, setInventoriesReady] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchHarnessInventoriesCached(client).then((rows) => {
      if (cancelled) return;
      setInventories(rows);
      setInventoriesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  return { inventories, inventoriesReady };
}
