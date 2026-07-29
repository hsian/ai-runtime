const NON_ACTIONABLE_PLAN_INPUT =
  /^(你好|您好|hi|hello|test|测试|在吗|在不在)$/i;

/** 只拦截明确的寒暄或测试词；短指令是否完整交给 Claude 结合会话判断。 */
export function isNonActionablePlanInput(prompt: string): boolean {
  return NON_ACTIONABLE_PLAN_INPUT.test(prompt.trim());
}
