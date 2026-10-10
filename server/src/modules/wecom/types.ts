export interface WecomSession {
  session_key: string;
  owner_id: string;
  target_id: string;
  user_id: string;
  conversation_id: string;
  active_job_id: string | null;
}

export interface WecomJobBinding {
  job_id: string;
  session_key: string;
  target_id: string;
  user_id: string;
}

export interface WecomNotice {
  signature: string;
  id: number;
  job_id: string;
  target_id: string;
  chunks: string;
  sent_chunks: number;
}
