export type TurnFooter = {
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  running: boolean;
  providerID?: string;
  modelID?: string;
  thinkingLevel?: string;
};
