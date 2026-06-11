import { Button } from "@/components/ui/button";

export function NoProjectConnected({
  canStartChat,
  onStartChat,
}: {
  canStartChat: boolean;
  onStartChat: () => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-md text-center space-y-4">
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold tracking-tight">No project connected</h2>
          <p className="text-sm text-muted-foreground">
            {canStartChat
              ? "Connect a project now or start a chat."
              : "Connect a project to start chatting."}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canStartChat && (
            <Button type="button" onClick={onStartChat}>
              Start a chat
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function NoSessionSelected() {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-md text-center space-y-1.5">
        <h2 className="text-lg font-semibold tracking-tight">No session selected</h2>
        <p className="text-sm text-muted-foreground">
          Select a session or start a new one from a connected project.
        </p>
      </div>
    </div>
  );
}
