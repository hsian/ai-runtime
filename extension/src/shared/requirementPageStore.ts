import type { TapdRequirement } from "./types.js";

const PAGE_STATE_KEY = "requirementPageState";

export type StoredAnalyzeStatus = "running" | "completed" | "cancelled" | "failed";

export interface StoredAnalyzeSession {
  sessionId: string;
  serverUrl: string;
  startedAt: number;
  status: StoredAnalyzeStatus;
  progressLog: string[];
  lastLabel?: string;
}

export interface RequirementPageState {
  requirement: TapdRequirement | null;
  draftPrompt: string;
  analyzeSession: StoredAnalyzeSession | null;
}

export async function loadRequirementPageState(): Promise<RequirementPageState | null> {
  const stored = await chrome.storage.local.get([PAGE_STATE_KEY]);
  const state = stored[PAGE_STATE_KEY];
  if (!state || typeof state !== "object") return null;
  return state as RequirementPageState;
}

export async function saveRequirementPageState(state: RequirementPageState): Promise<void> {
  await chrome.storage.local.set({ [PAGE_STATE_KEY]: state });
}

export async function clearAnalyzeSessionState(): Promise<void> {
  const state = await loadRequirementPageState();
  if (!state) return;
  await saveRequirementPageState({ ...state, analyzeSession: null });
}

export function emptyPageState(): RequirementPageState {
  return {
    requirement: null,
    draftPrompt: "",
    analyzeSession: null,
  };
}
