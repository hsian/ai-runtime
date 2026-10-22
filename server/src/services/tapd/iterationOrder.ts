import type { TapdIteration } from "./tapdClient.js";

function dateKey(value: string | undefined): number | undefined {
  const match = value?.match(/(\d{4})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(?:(\d{1,2})(?:日|号)?)?/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3] || 1);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.getTime();
}

/** Keep the same chronological order across all iteration pickers. */
export function sortIterations(iterations: TapdIteration[]): TapdIteration[] {
  return iterations.map(iteration => ({
    iteration,
    date: dateKey(iteration.name) ?? dateKey(iteration.enddate) ?? dateKey(iteration.startdate) ?? -Infinity,
  })).sort((a, b) => a.date === b.date ? 0 : a.date > b.date ? -1 : 1)
    .map(item => item.iteration);
}
