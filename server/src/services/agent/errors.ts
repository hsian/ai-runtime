export class AgentAbortedError extends Error {
  constructor() {
    super("Agent 已中止");
    this.name = "AgentAbortedError";
  }
}
