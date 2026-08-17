import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from "@ant-design/icons";
import { Empty } from "antd";

import type { JobEvent } from "../types";

const phaseLabel: Record<string, string> = {
  pull: "同步最新代码",
  plan: "分析修改方案",
  plan_done: "方案生成完成",
  execute_confirmed: "确认执行",
  branch: "创建任务分支",
  agent: "Agent 修改代码",
  attachments: "准备任务附件",
  commit: "提交代码",
  merge: "合并并推送",
  default_merge_done: "合并完成",
  release_merge: "合并发版分支",
  release_merge_done: "发版分支完成",
  default_revert: "撤回提交",
  default_revert_done: "撤回完成",
};

export function ExecutionTimeline({ events }: { events: JobEvent[] }) {
  const stages = events.filter((event) => event.type === "stage" || event.type === "done" || event.type === "error" || event.type === "cancelled");
  if (stages.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="任务开始后显示执行阶段" />;

  return (
    <div className="execution-timeline">
      {stages.map((event, index) => {
        const failed = event.type === "error";
        const cancelled = event.type === "cancelled";
        const completed = event.type === "done";
        const isLast = index === stages.length - 1;
        return (
          <div className="timeline-row" key={event.id}>
            <div className={`timeline-icon${failed ? " is-error" : cancelled ? " is-muted" : ""}`}>
              {failed ? <CloseCircleFilled /> : isLast && !completed && !/done/.test(event.phase ?? "") ? <LoadingOutlined /> : <CheckCircleFilled />}
            </div>
            <div className="timeline-copy">
              <strong>{phaseLabel[event.phase ?? ""] || (failed ? "执行失败" : cancelled ? "任务取消" : completed ? "任务完成" : event.phase || "任务进度")}</strong>
              <span>{event.text || event.message}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
