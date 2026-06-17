/** 将 AI 整理结果格式化为「每段编号单独一行」 */
export function formatPolishedRequirementText(text: string): string {
  let result = text
    .replace(/\[图片(?::[^\]]*)?\]/g, "")
    .replace(/^\s*(图片|配图)\s*$/gm, "")
    .trim();

  // 粘连编号：修改2. 需求描述 -> 修改\n\n2. 需求描述
  result = result.replace(/([^\n\s\d])(\d{1,2})[.、]\s*/g, "$1\n\n$2. ");

  // 同一行内的后续编号：...描述。3. 下一项
  result = result.replace(/([^\n])(\d{1,2})[.、]\s+/g, "$1\n\n$2. ");

  result = result.replace(/^(\d{1,2})[、.]\s*/gm, "$1. ");
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}
