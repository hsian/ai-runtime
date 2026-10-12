// Read-only integration check. Never starts the bot, writes task states or sends messages.
import { getTapdConfig } from "../dist/config.js";
import { listIterations, getIterationWorkItems } from "../dist/services/tapd/tapdClient.js";
import { currentMonthIteration } from "../dist/modules/wecom/tapdCompletion.js";
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
    const workItems = await getIterationWorkItems(iteration.id, id, cfg);
    const tasks = [...workItems.stories.flatMap(story => story.tasks), ...workItems.orphanTasks];
    Object.assign(result, { sampleIteration: iteration.name, stories: workItems.stories.length, tasks: tasks.length,
      backendTasks: tasks.filter(task => task.name.trim().startsWith("后端")).length,
      frontendTasks: tasks.filter(task => task.name.trim().startsWith("前端")).length,
      recipientMatches: Object.keys(options.recipients).filter(name => tasks.some(task =>
        task.name.trim().startsWith("前端") && (task.owner ?? "").split(/[;；,，]/).some(owner => owner.trim() === name))),
      fullScanVerified: true });
  }
  console.log(JSON.stringify(result));
}
