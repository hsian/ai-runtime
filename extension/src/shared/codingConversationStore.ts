import type { CodingConversation, TapdContext } from "./types.js";

const CONVERSATIONS_KEY = "codingConversations";
const ACTIVE_CONVERSATION_KEY = "activeCodingConversationId";

function normalizeConversation(raw: unknown): CodingConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string") return null;
  const now = new Date().toISOString();
  const jobIds = Array.isArray(value.jobIds)
    ? value.jobIds.filter((item): item is string => typeof item === "string")
    : [];
  const hasTapdContext = Boolean(
    value.tapdContext &&
    typeof value.tapdContext === "object" &&
    typeof (value.tapdContext as TapdContext).title === "string"
  );
  return {
    id: value.id,
    title: typeof value.title === "string" && value.title.trim() ? value.title : "新会话",
    jobIds,
    tapdContext:
      value.tapdContext &&
      typeof value.tapdContext === "object" &&
      typeof (value.tapdContext as TapdContext).title === "string"
        ? {
            ...(value.tapdContext as TapdContext),
            itemType:
              (value.tapdContext as TapdContext).itemType === "task" ||
              (value.tapdContext as TapdContext).itemType === "bug"
                ? (value.tapdContext as TapdContext).itemType
                : "story",
            itemId:
              (value.tapdContext as TapdContext).itemId ||
              (value.tapdContext as TapdContext).storyId ||
              "",
            transportMode:
              (value.tapdContext as TapdContext).transportMode === "structured"
                ? "structured"
                : "legacy",
            excludedImageIndexes: Array.isArray(
              (value.tapdContext as TapdContext).excludedImageIndexes
            )
              ? (value.tapdContext as TapdContext).excludedImageIndexes?.filter(
                  (item): item is number => Number.isInteger(item) && item > 0
                )
              : undefined,
          }
        : undefined,
    tapdContextPending: hasTapdContext
      ? typeof value.tapdContextPending === "boolean"
        ? value.tapdContextPending
        : jobIds.length === 0
      : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

async function readConversations(): Promise<CodingConversation[]> {
  const stored = await chrome.storage.local.get([CONVERSATIONS_KEY]);
  const values = stored[CONVERSATIONS_KEY];
  if (!Array.isArray(values)) return [];
  return values
    .map(normalizeConversation)
    .filter((item): item is CodingConversation => item !== null)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

async function writeConversations(conversations: CodingConversation[]): Promise<void> {
  await chrome.storage.local.set({ [CONVERSATIONS_KEY]: conversations });
}

export async function listCodingConversations(): Promise<CodingConversation[]> {
  return readConversations();
}

export async function createCodingConversation(
  title = "新会话",
  options?: { activate?: boolean }
): Promise<CodingConversation> {
  const now = new Date().toISOString();
  const conversation: CodingConversation = {
    id: crypto.randomUUID(),
    title,
    jobIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const conversations = await readConversations();
  conversations.unshift(conversation);
  await writeConversations(conversations);
  if (options?.activate !== false) {
    await chrome.storage.local.set({ [ACTIVE_CONVERSATION_KEY]: conversation.id });
  }
  return conversation;
}

export async function getCodingConversation(
  conversationId: string
): Promise<CodingConversation | undefined> {
  return (await readConversations()).find((item) => item.id === conversationId);
}

export async function getActiveCodingConversation(): Promise<CodingConversation> {
  const [conversations, stored] = await Promise.all([
    readConversations(),
    chrome.storage.local.get([ACTIVE_CONVERSATION_KEY]),
  ]);
  const activeId = stored[ACTIVE_CONVERSATION_KEY];
  const active =
    typeof activeId === "string"
      ? conversations.find((item) => item.id === activeId)
      : undefined;
  if (active) return active;
  if (conversations[0]) {
    await chrome.storage.local.set({ [ACTIVE_CONVERSATION_KEY]: conversations[0].id });
    return conversations[0];
  }
  return createCodingConversation();
}

export async function setActiveCodingConversation(conversationId: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_CONVERSATION_KEY]: conversationId });
}

export async function deleteCodingConversation(conversationId: string): Promise<void> {
  const conversations = await readConversations();
  await writeConversations(conversations.filter((item) => item.id !== conversationId));
  const stored = await chrome.storage.local.get([ACTIVE_CONVERSATION_KEY]);
  if (stored[ACTIVE_CONVERSATION_KEY] === conversationId) {
    await chrome.storage.local.remove([ACTIVE_CONVERSATION_KEY]);
  }
}

export async function addJobToCodingConversation(
  conversationId: string,
  jobId: string,
  firstPrompt?: string
): Promise<void> {
  const conversations = await readConversations();
  const index = conversations.findIndex((item) => item.id === conversationId);
  if (index < 0) return;
  const current = conversations[index];
  const now = new Date().toISOString();
  const promptTitle = firstPrompt?.replace(/\s+/g, " ").trim();
  const title =
    current.title === "新会话" && promptTitle
      ? promptTitle.length > 32
        ? `${promptTitle.slice(0, 32)}…`
        : promptTitle
      : current.title;
  conversations[index] = {
    ...current,
    title,
    jobIds: current.jobIds.includes(jobId) ? current.jobIds : [...current.jobIds, jobId],
    updatedAt: now,
  };
  await writeConversations(conversations);
}

export async function setCodingConversationTapdContext(
  conversationId: string,
  tapdContext?: TapdContext,
  pending?: boolean
): Promise<void> {
  const conversations = await readConversations();
  const index = conversations.findIndex((item) => item.id === conversationId);
  if (index < 0) return;
  conversations[index] = {
    ...conversations[index],
    tapdContext,
    tapdContextPending: tapdContext
      ? pending ?? conversations[index].tapdContextPending ?? true
      : undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeConversations(conversations);
}

export async function addExistingConversation(input: {
  title: string;
  jobId?: string;
}): Promise<CodingConversation> {
  const conversation = await createCodingConversation(input.title || "历史任务", {
    activate: false,
  });
  if (input.jobId) {
    await addJobToCodingConversation(conversation.id, input.jobId);
  }
  return (await getCodingConversation(conversation.id)) ?? conversation;
}
