import type { Part } from "@opencode-ai/sdk/v2/client";
import { memo } from "react";
import { ToolPartView } from "@/components/message-list/tools/ToolPartView";
import { FilePartView } from "./FilePartView";
import { ReasoningPartView } from "./ReasoningPartView";
import { TextPartView } from "./TextPartView";

export const PartView = memo(function PartView({
  part,
  isUser,
  lastReasoningPartId,
}: {
  part: Part;
  isUser?: boolean;
  lastReasoningPartId?: string;
}) {
  switch (part.type) {
    case "text":
      return <TextPartView part={part} isUser={isUser} />;
    case "file":
      return <FilePartView part={part} />;
    case "reasoning":
      return <ReasoningPartView part={part} isLastReasoning={part.id === lastReasoningPartId} />;
    case "tool":
      return <ToolPartView part={part} />;
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
    case "compaction":
    case "retry":
      return null;
    default:
      return null;
  }
});
