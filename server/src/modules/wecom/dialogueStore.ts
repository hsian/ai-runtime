import { getDatabase } from "../../services/database.js";
import type { WecomSession } from "./types.js";

export interface DialogueState {
  step: "selection" | "revert_confirm" | "reverting";
  sourceJobId?: string;
  question?: string;
  choices?: { id: string; text: string }[];
}

export function initDialogueStore(): void {
  getDatabase().exec(`CREATE TABLE IF NOT EXISTS wecom_dialogue_state (
    session_key TEXT NOT NULL, conversation_id TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(session_key, conversation_id)
  )`);
  // Restart never automatically resumes a potentially interrupted Git operation.
  getDatabase().prepare(`UPDATE wecom_dialogue_state SET state = json_set(state, '$.step', 'revert_confirm')
    WHERE json_extract(state, '$.step') = 'reverting'`).run();
  getDatabase().prepare(`DELETE FROM wecom_dialogue_state WHERE json_extract(state, '$.sourceJobId') IN
    (SELECT job_id FROM jobs WHERE json_extract(data, '$.revertedFromDefaultAt') IS NOT NULL)`).run();
}

export function getDialogue(session: WecomSession): DialogueState | undefined {
  const row = getDatabase().prepare("SELECT state FROM wecom_dialogue_state WHERE session_key = ? AND conversation_id = ?")
    .get(session.session_key, session.conversation_id) as { state: string } | undefined;
  return row ? JSON.parse(row.state) : undefined;
}

export function isJobReverting(jobId: string): boolean {
  return Boolean(getDatabase().prepare(`SELECT 1 FROM wecom_dialogue_state
    WHERE json_extract(state, '$.sourceJobId') = ? AND json_extract(state, '$.step') = 'reverting'`).get(jobId));
}

export function setDialogue(session: WecomSession, state?: DialogueState): void {
  if (!state) {
    getDatabase().prepare("DELETE FROM wecom_dialogue_state WHERE session_key = ? AND conversation_id = ?")
      .run(session.session_key, session.conversation_id);
    return;
  }
  getDatabase().prepare("INSERT OR REPLACE INTO wecom_dialogue_state VALUES (?, ?, ?)")
    .run(session.session_key, session.conversation_id, JSON.stringify(state));
}

// Register only explicitly labelled choices, never infer execution permission from prose.
export function rememberChoices(session: WecomSession, answer: string): void {
  if (getDialogue(session)?.step?.startsWith("revert")) return;
  const choices = [...answer.matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:选\s*)?([A-Z])\s*(?:\*\*)?\s*[→:：、.)）\-]\s*(.+)$/gm)]
    .map(match => ({ id: match[1], text: match[2].slice(0, 1200) }));
  if (new Set(choices.map(choice => choice.id)).size >= 2) {
    setDialogue(session, { step: "selection", question: answer.slice(-6000), choices });
  }
}
