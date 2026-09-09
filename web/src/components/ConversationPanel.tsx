import { CodeOutlined, ExperimentOutlined, FileTextOutlined, ToolOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Divider, Image, Input, Space, Tag, Typography } from "antd";
import { useMemo } from "react";

import type { AgentProvider, ClarificationAnswer, JobEvent, JobStatus, TaskMode } from "../types";
import { ClarificationCard } from "./ClarificationCard";
import { TestCaseResult } from "./TestCaseResult";

function JobTurn(props: {
  job: JobStatus;
  events: JobEvent[];
  busy: boolean;
  isCurrent: boolean;
  agentProvider: AgentProvider;
  planDraft?: string;
  onPlanChange: (jobId: string, value: string) => void;
  onExecute: (planSummary: string) => void;
  onClarify: (jobId: string, answers: ClarificationAnswer[], note: string, files: File[]) => void;
}) {
  const agentText = useMemo(() => {
    const planDoneIndex = props.events.findIndex((event) => event.type === "stage" && event.phase === "plan_done");
    const visibleEvents = props.job.planSummary
      ? planDoneIndex >= 0 ? props.events.slice(planDoneIndex + 1) : []
      : props.events;
    return visibleEvents.filter((event) => event.type === "agent_text").map((event) => event.delta ?? "").join("");
  }, [props.events, props.job.planSummary]);
  const tools = useMemo(() => props.events.filter((event) => event.type === "agent_tool"), [props.events]);
  const planValue = props.planDraft ?? props.job.planSummary ?? "";

  return (
    <div className="conversation-turn">
      <div className="message user-message">
        <div className="message-heading">
          <div className="message-avatar"><UserOutlined /></div>
          <div className="message-label">你提交的需求</div>
        </div>
        <div className="user-bubble">
          <div className="message-body">{props.job.prompt}</div>
          {props.job.attachments && props.job.attachments.length > 0 && (
            <div className="message-attachments">
              {props.job.attachments.map((attachment) => (
                <div className="message-attachment" key={attachment.index}>
                  <Image src={attachment.url} alt={attachment.name} />
                  <span>{attachment.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {props.job.planSummary && (
        <Card className="plan-card" title={<Space><FileTextOutlined />修改方案</Space>}>
          {props.isCurrent && props.job.status === "awaiting_confirm" ? (
            <Input.TextArea
              className="plan-editor"
              value={planValue}
              autoSize={{ minRows: 6, maxRows: 18 }}
              onChange={(event) => props.onPlanChange(props.job.jobId, event.target.value)}
            />
          ) : (
            <div className="rich-text">{props.job.planSummary}</div>
          )}
          {props.isCurrent && props.job.status === "awaiting_confirm" && (
            <div className="plan-actions">
              <Alert
                type="warning"
                showIcon
                message={`可先调整方案，将使用 ${props.agentProvider === "codex" ? "Codex" : "默认模式"}执行代码修改`}
              />
              <Button
                type="primary"
                size="large"
                loading={props.busy}
                disabled={!planValue.trim()}
                onClick={() => props.onExecute(planValue)}
              >
                确认并开始执行
              </Button>
            </div>
          )}
        </Card>
      )}

      {tools.length > 0 && (
        <details className="tool-details">
          <summary><ToolOutlined /> 执行详情 <Tag>{tools.length}</Tag></summary>
          <div className="tool-list">
            {tools.slice(-30).map((event) => <div key={event.id}><code>{event.toolName}</code><span>{event.toolDetail}</span></div>)}
          </div>
        </details>
      )}

      {agentText && (
        <Card className="agent-card" title={<Space><CodeOutlined />Agent 输出</Space>}>
          <div className="rich-text">{agentText}</div>
        </Card>
      )}

      {props.job.clarificationHistory?.map((exchange) => (
        <Card className="clarification-history-card" size="small" key={exchange.answeredAt} title="已补充的信息">
          {exchange.answers.map((answer) => (
            <div className="clarification-history-item" key={`${exchange.answeredAt}-${answer.questionId}`}>
              <Typography.Text type="secondary">{answer.question}</Typography.Text>
              <Typography.Text>{answer.value}</Typography.Text>
            </div>
          ))}
          {exchange.note && <div className="clarification-history-item"><Typography.Text type="secondary">补充说明</Typography.Text><Typography.Text>{exchange.note}</Typography.Text></div>}
        </Card>
      ))}

      {props.isCurrent && props.job.status === "awaiting_input" && Boolean(props.job.clarificationQuestions?.length) && (
        <ClarificationCard
          questions={props.job.clarificationQuestions!}
          busy={props.busy}
          onSubmit={(answers, note, files) => props.onClarify(props.job.jobId, answers, note, files)}
        />
      )}

      {props.job.testCaseDocument && <TestCaseResult jobId={props.job.jobId} document={props.job.testCaseDocument} />}

      {props.job.status === "failed" && <Alert type="error" showIcon message="任务执行失败" description={props.job.error || props.job.message} />}
      {props.job.status === "cancelled" && <Alert type="info" showIcon message="任务已取消" />}
    </div>
  );
}

export function ConversationPanel(props: {
  jobs: JobStatus[];
  currentJob?: JobStatus;
  taskMode: TaskMode;
  agentProvider: AgentProvider;
  eventsByJob: Record<string, JobEvent[]>;
  planDrafts: Record<string, string>;
  busy: boolean;
  onTaskModeChange: (value: TaskMode) => void;
  onPlanChange: (jobId: string, value: string) => void;
  onExecute: (planSummary: string) => void;
  onClarify: (jobId: string, answers: ClarificationAnswer[], note: string, files: File[]) => void;
}) {
  if (props.jobs.length === 0) {
    return (
      <div className="welcome-state">
        <div className="welcome-icon"><CodeOutlined /></div>
        <Typography.Title level={2}>从问题、修改需求或测试需求开始</Typography.Title>
        <Typography.Paragraph>
          支持的项目：B2B 管理后台（村财、监管、村居委、产权、支付中台）和粤农交测试版小程序；其他项目暂不支持。
        </Typography.Paragraph>
        <div className="starter-grid">
          <button
            type="button"
            className={props.taskMode === "question" ? "is-active" : undefined}
            aria-pressed={props.taskMode === "question"}
            onClick={() => props.onTaskModeChange("question")}
          >
            <FileTextOutlined /><strong>项目问答</strong><span>读取仓库并回答，不修改代码</span>
          </button>
          <button
            type="button"
            className={props.taskMode === "code" ? "is-active" : undefined}
            aria-pressed={props.taskMode === "code"}
            onClick={() => props.onTaskModeChange("code")}
          >
            <CodeOutlined /><strong>功能修改</strong><span>先确认修改方案，再自动执行</span>
          </button>
          <button
            type="button"
            className={props.taskMode === "test-case" ? "is-active" : undefined}
            aria-pressed={props.taskMode === "test-case"}
            onClick={() => props.onTaskModeChange("test-case")}
          >
            <ExperimentOutlined /><strong>测试用例</strong><span>分析需求与代码，生成 Excel 用例</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="conversation-content">
      {props.jobs.map((job, index) => (
        <div key={job.jobId}>
          {index > 0 && <Divider className="turn-divider">第 {index + 1} 轮</Divider>}
          <JobTurn
            job={job}
            events={props.eventsByJob[job.jobId] ?? []}
            busy={props.busy}
            isCurrent={job.jobId === props.currentJob?.jobId}
            agentProvider={props.agentProvider}
            planDraft={props.planDrafts[job.jobId]}
            onPlanChange={props.onPlanChange}
            onExecute={props.onExecute}
            onClarify={props.onClarify}
          />
        </div>
      ))}
    </div>
  );
}
