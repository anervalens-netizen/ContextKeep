import { create } from "zustand";
import type { ConflictEntry } from "../lib/offline/db.js";

export interface Notice {
  kind: "info" | "success" | "error" | "queued";
  text: string;
}

interface UiState {
  offline: boolean;
  setOffline: (v: boolean) => void;

  queuedCount: number;
  setQueuedCount: (n: number) => void;

  /** A10: conflicts surfaced when the offline queue replays against moved state. */
  conflicts: ConflictEntry[];
  setConflicts: (c: ConflictEntry[]) => void;
  dismissConflict: (seq: number) => void;

  /** Prompt-for-update flow on top of autoUpdate (handoff §9/§14). */
  updateReady: boolean;
  setUpdateReady: (v: boolean) => void;

  notice: Notice | null;
  setNotice: (n: Notice | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  offline: false,
  setOffline: (v) => set({ offline: v }),

  queuedCount: 0,
  setQueuedCount: (n) => set({ queuedCount: n }),

  conflicts: [],
  setConflicts: (c) => set({ conflicts: c }),
  dismissConflict: (seq) => set((s) => ({ conflicts: s.conflicts.filter((c) => c.seq !== seq) })),

  updateReady: false,
  setUpdateReady: (v) => set({ updateReady: v }),

  notice: null,
  setNotice: (n) => set({ notice: n }),
}));
