import type { TestCaseDocument, TestCaseItem } from "../../types.js";

export function normalizeTestCaseText(text: string): string {
  return text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\r\n?/g, "\n").trim();
}

export function normalizeTestCaseSteps(steps: string[]): string[] {
  return steps.flatMap(step => normalizeTestCaseText(step).split("\n"))
    .map(step => step.trim().replace(/^\d+\s*[、.．)）]\s*/, "").trim())
    .filter(Boolean);
}

// Preserve first-seen group order and the scenario order within each function.
export function normalizeTestCaseDocument(document: TestCaseDocument): TestCaseDocument {
  const modules = new Map<string, Map<string, Map<string, TestCaseItem[]>>>();
  for (const item of document.cases) {
    const normalized = {
      ...item,
      levelOneModule: normalizeTestCaseText(item.levelOneModule),
      levelTwoModule: normalizeTestCaseText(item.levelTwoModule),
      requirementPoint: normalizeTestCaseText(item.requirementPoint),
      testPoint: normalizeTestCaseText(item.testPoint),
      preconditions: normalizeTestCaseText(item.preconditions),
      steps: normalizeTestCaseSteps(item.steps),
      expectedResult: normalizeTestCaseText(item.expectedResult),
    };
    let pages = modules.get(normalized.levelOneModule);
    if (!pages) modules.set(normalized.levelOneModule, pages = new Map());
    let functions = pages.get(normalized.levelTwoModule);
    if (!functions) pages.set(normalized.levelTwoModule, functions = new Map());
    let cases = functions.get(normalized.requirementPoint);
    if (!cases) functions.set(normalized.requirementPoint, cases = []);
    cases.push(normalized);
  }
  const cases = [...modules.values()].flatMap(pages => [...pages.values()]
    .flatMap(functions => [...functions.values()].flat()));
  return { ...document, cases: cases.map((item, index) => ({ ...item, caseNumber: index + 1 })) };
}
