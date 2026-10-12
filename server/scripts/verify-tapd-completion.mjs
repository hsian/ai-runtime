// Read-only integration check. Never starts the bot, writes task states or sends messages.
import { getTapdConfig } from "../dist/config.js";
import { listIterations, listIterationTasks } from "../dist/services/tapd/tapdClient.js";
import { currentMonthIteration, tapdTimestamp } from "../dist/modules/wecom/tapdCompletion.js";
import { getWecomConfig } from "../dist/modules/wecom/config.js";

const cfg = getTapdConfig();
const options = getWecomConfig()?.tapdCompletion;
if (!options) throw new Error("TAPD 完成通知未启用");
const now = new Date();
for (const id of options.workspaceIds) {
  const iterations = (await listIterations(id, cfg)).filter(item => currentMonthIteration(item.name, now));
  const result = { project: cfg.workspaces.find(item => item.id === id)?.name, currentMonthIterations: iterations.length };
  if (iterations.length) {
    const iteration = iterations[0];
    const tasks = await listIterationTasks(iteration.id, { workspaceId: id }, cfg);
    // Future timestamps should return no records: verifies the API actually applies the incremental filter.
    const future = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    const futureTasks = await listIterationTasks(iteration.id, { workspaceId: id, modified: `>${tapdTimestamp(future)}` }, cfg);
    if (futureTasks.length) throw new Error("TAPD 未正确应用 modified 筛选，请勿启用轮询");
    Object.assign(result, { sampleIteration: iteration.name, tasks: tasks.length,
      backendTasks: tasks.filter(task => task.name.trim().startsWith("后端")).length,
      frontendTasks: tasks.filter(task => task.name.trim().startsWith("前端")).length,
      recipientMatches: Object.keys(options.recipients).filter(name => tasks.some(task =>
        task.name.trim().startsWith("前端") && (task.owner ?? "").split(/[;；,，]/).some(owner => owner.trim() === name))),
      incrementalFilterVerified: true });
  }
  console.log(JSON.stringify(result));
}
