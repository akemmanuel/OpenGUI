import { Input } from "@/components/ui/input";

export function RemoteProjectInput({
  workspaceName,
  value,
  normalizedValue,
  onChange,
  onCancel,
  onOpen,
}: {
  workspaceName?: string;
  value: string;
  normalizedValue: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onOpen: (path: string) => void;
}) {
  return (
    <div className="mx-3 mt-3 space-y-2 rounded-lg border bg-sidebar-accent/30 p-2 group-data-[collapsible=icon]:hidden">
      <div className="text-[11px] text-muted-foreground">Remote path on {workspaceName}</div>
      <div className="flex gap-2">
        <Input
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/remote/path/to/project"
          className="h-8 font-mono text-xs"
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel();
            if (event.key === "Enter" && normalizedValue) {
              event.preventDefault();
              onOpen(normalizedValue);
            }
          }}
        />
        <button
          type="button"
          onClick={() => normalizedValue && onOpen(normalizedValue)}
          className="flex h-8 items-center rounded-md bg-primary px-3 text-xs text-primary-foreground"
        >
          Open
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-8 items-center rounded-md border px-3 text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
