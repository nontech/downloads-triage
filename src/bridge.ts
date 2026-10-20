import type { Pile } from "../shared/types.ts";

export type TriageMenuState = {
  scanning: boolean;
  canTrash: boolean;
  canUndo: boolean;
  pile: Pile;
};

export type TriageBridge = {
  scan: () => void;
  showPile: (pile: Pile) => void;
  trash: () => void;
  undo: () => void;
};

declare global {
  interface Window {
    __triage?: TriageBridge;
    webkit?: {
      messageHandlers?: {
        triage?: { postMessage: (message: TriageMenuState | { openSettings: true }) => void };
      };
    };
  }
}
