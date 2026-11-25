import { create } from "zustand";

interface PresenceState {
  /** Members watching each session now (§B.4), from the server's `presence` messages. */
  bySession: Record<string, string[]>;
  set: (sessionId: string, memberIds: string[]) => void;
}

/** Who else is looking at a session; fed by the realtime socket. */
export const usePresenceStore = create<PresenceState>()((set) => ({
  bySession: {},
  set: (sessionId, memberIds) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: memberIds } })),
}));
