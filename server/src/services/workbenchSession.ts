/** Stable entry point shared by Web and WeCom. Scheduling is owned by one worker. */
import { killAgentForJob } from "./agent/index.js";
import { appendJobEvent } from "./jobEvents.js";
import { createWorkbenchController } from "./workbench/controller.js";
import { workbenchDependencies } from "./workbench/runtime.js";
import { createWorkbenchWorker } from "./workbench/worker.js";

export { createWorkbenchWorker, type WorkbenchWorkerDependencies } from "./workbench/worker.js";
export {
  WORKBENCH_DECISION_SCHEMA, parseWorkbenchDecision, parseWorkbenchReleaseTarget,
  isWorkbenchCancellation, isWorkbenchResetRequest, buildWorkbenchRequest,
} from "./workbench/protocol.js";

const worker = createWorkbenchWorker(workbenchDependencies);
const controller = createWorkbenchController({
  get: workbenchDependencies.get,
  update: workbenchDependencies.update,
  worker,
  kill: killAgentForJob,
  event: (id, event) => { appendJobEvent(id, event); },
});

export const assertWorkbenchCanReceive = controller.assertWorkbenchCanReceive;
export const receiveWorkbenchMessage = controller.receiveWorkbenchMessage;
export const pauseWorkbenchSession = controller.pauseWorkbenchSession;
