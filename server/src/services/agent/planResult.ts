import { z } from "zod";
import type { ClarificationQuestion } from "../../types.js";

const questionSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["single_choice", "text"]),
  question: z.string().min(1).max(500),
  reason: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).max(6).optional(),
  recommendedOption: z.string().max(200).optional(),
  allowOther: z.boolean().optional(),
  required: z.boolean(),
});

const resultSchema = z.object({
  result: z.enum(["ready", "needs_input"]),
  summary: z.string().max(10_000),
  questions: z.array(questionSchema).max(2),
});

export const PLAN_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["result", "summary", "questions"],
  properties: {
    result: { type: "string", enum: ["ready", "needs_input"] },
    summary: { type: "string" },
    questions: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "question", "reason", "options", "recommendedOption", "allowOther", "required"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["single_choice", "text"] },
          question: { type: "string" },
          reason: { type: "string" },
          options: { type: "array", items: { type: "string" }, maxItems: 6 },
          recommendedOption: { type: "string" },
          allowOther: { type: "boolean" },
          required: { type: "boolean" },
        },
      },
    },
  },
};

export type ParsedPlanResult =
  | { result: "ready"; summary: string }
  | { result: "needs_input"; summary: string; questions: ClarificationQuestion[] };

export function parsePlanResult(output: string): ParsedPlanResult {
  try {
    const parsed = resultSchema.parse(JSON.parse(output));
    if (parsed.result === "needs_input" && parsed.questions.length > 0) {
      const usedIds = new Set<string>();
      const questions = parsed.questions.map((question, index) => {
        const options = question.type === "single_choice"
          ? [...new Set(question.options ?? [])].slice(0, 6)
          : undefined;
        const requestedId = question.id.trim() || `question_${index + 1}`;
        const id = usedIds.has(requestedId) ? `${requestedId}_${index + 1}` : requestedId;
        usedIds.add(id);
        return {
          ...question,
          id,
          options,
          recommendedOption: options?.includes(question.recommendedOption ?? "")
            ? question.recommendedOption
            : undefined,
          allowOther: question.type === "single_choice" ? question.allowOther !== false : undefined,
        };
      }).filter((question) => question.type === "text" || Boolean(question.options?.length));
      if (questions.length > 0) {
        return {
          result: "needs_input",
          summary: parsed.summary.trim(),
          questions,
        };
      }
    }
    if (parsed.summary.trim()) return { result: "ready", summary: parsed.summary.trim() };
  } catch {
    // 兼容未遵循结构化输出的旧版或异常 Agent。
  }

  const trimmed = output.trim();
  if (trimmed.includes("【需要补充】")) {
    return {
      result: "needs_input",
      summary: "",
      questions: [{
        id: "missing_information",
        type: "text",
        question: trimmed.replace("【需要补充】", "").replace(/^[-\s]+/, "").trim() || "请补充完成本次修改所需的业务信息。",
        reason: "缺少的信息会影响最终产品行为。",
        required: true,
      }],
    };
  }
  return { result: "ready", summary: trimmed || "Plan 分析完成" };
}
