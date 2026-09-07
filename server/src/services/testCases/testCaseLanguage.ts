import type { TestCaseDocument } from "../../types.js";

const TECHNICAL_TOKEN_PATTERNS = [
  /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g,
  /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g,
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi,
  /\b[^\s/\\]+\.(?:ts|tsx|js|jsx|vue|java|kt|py|go|cs|php|less|scss)\b/gi,
  /(?:[A-Za-z]:)?[\\/](?:src|apps|packages|components|views|services|api)[\\/][^\s，。；]+/gi,
];

function documentText(document: TestCaseDocument): string {
  const assessment = document.implementationAssessment;
  return [
    document.moduleName,
    document.functionDescription,
    assessment?.summary,
    ...(assessment?.evidence ?? []),
    ...(assessment?.gaps ?? []),
    ...document.cases.flatMap((item) => [
      item.levelOneModule,
      item.levelTwoModule,
      item.requirementPoint,
      item.testPoint,
      item.preconditions,
      ...item.steps,
      item.expectedResult,
    ]),
  ].filter(Boolean).join("\n");
}

export function findTechnicalTokens(document: TestCaseDocument): string[] {
  const text = documentText(document);
  const matches = TECHNICAL_TOKEN_PATTERNS.flatMap((pattern) => text.match(pattern) ?? []);
  return [...new Set(matches.map((item) => item.trim()))].slice(0, 20);
}
