import { AppstoreOutlined, DeleteOutlined, LockOutlined, LogoutOutlined, PlusOutlined, RobotOutlined } from "@ant-design/icons";
import { Button, Dropdown, Empty, Skeleton, Tooltip } from "antd";

import type { JobStatus, ProjectProfile } from "../types";
import { StatusBadge } from "./StatusBadge";
import { resolveTaskMode, taskModeLabels } from "../utils/taskMode";

function relativeDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function TaskSidebar(props: {
  jobs: JobStatus[];
  selectedJobId?: string;
  loading: boolean;
  projects: ProjectProfile[];
  onSelect: (jobId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string, projectId: string, title: string) => void;
  isAuthenticated: boolean;
  canManageUsers: boolean;
  onLogout: () => void;
}) {
  const projectNames = new Map(props.projects.map((project) => [project.id, project.name]));
  const conversations = Array.from(
    props.jobs.reduce((groups, job) => {
      const key = `${job.projectId}:${job.conversationId || job.jobId}`;
      const current = groups.get(key) ?? [];
      current.push(job);
      groups.set(key, current);
      return groups;
    }, new Map<string, JobStatus[]>()).entries()
  ).map(([id, jobs]) => {
    const ordered = [...jobs].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    return { id, conversationId: ordered[0].conversationId || ordered[0].jobId, projectId: ordered[0].projectId, jobs: ordered, first: ordered[0], latest: ordered[ordered.length - 1] };
  }).sort((left, right) => new Date(right.latest.updatedAt).getTime() - new Date(left.latest.updatedAt).getTime());

  return (
    <aside className="task-sidebar">
      <div className="brand">
        <div className="brand-mark"><RobotOutlined /></div>
        <div>
          <strong>Code Agent</strong>
          <span>智能任务工作台</span>
        </div>
      </div>

      <div className="sidebar-task-actions">
        <Button type="primary" icon={<PlusOutlined />} block size="large" onClick={props.onNew}>
          新建任务
        </Button>
      </div>

      <div className="sidebar-section-title">
        <span>最近任务</span>
        <span>{conversations.length}</span>
      </div>

      <div className="task-list">
        {props.loading && props.jobs.length === 0 ? (
          <Skeleton active paragraph={{ rows: 5 }} title={false} />
        ) : conversations.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任务" />
        ) : (
          conversations.map((conversation) => (
            <div
              role="button"
              tabIndex={0}
              className={`task-item${conversation.jobs.some((job) => props.selectedJobId === job.jobId) ? " is-active" : ""}`}
              key={conversation.id}
              onClick={() => props.onSelect(conversation.latest.jobId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") props.onSelect(conversation.latest.jobId);
              }}
            >
              <div className="task-item-top">
                <StatusBadge status={conversation.latest.status} />
                <div className="task-item-top-actions">
                  <span>{relativeDate(conversation.latest.updatedAt)}</span>
                  <Tooltip title="删除任务">
                    <Button
                      className="task-item-delete"
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onDelete(conversation.conversationId, conversation.projectId, conversation.first.prompt || "未命名会话");
                      }}
                    />
                  </Tooltip>
                </div>
              </div>
              <Tooltip title={conversation.first.prompt} placement="right">
                <div className="task-item-title">{conversation.first.prompt || "未命名会话"}</div>
              </Tooltip>
              <div className="task-item-meta">
                {projectNames.get(conversation.latest.projectId) || "B2B 管理后台"}
                {" · "}
                {taskModeLabels[resolveTaskMode(conversation.latest)]}
                {conversation.jobs.length > 1 ? ` · ${conversation.jobs.length} 轮` : ""}
              </div>
            </div>
          ))
        )}
      </div>
      <Dropdown menu={{ items: [
        { key: "hours", label: <a href="/work-hours">填写工时</a> },
        { key: "stats", label: <a href="/stats">内部统计</a> },
        ...(props.canManageUsers ? [{ key: "users", label: <a href="/account-management">账号管理</a> }] : []),
        ...(props.isAuthenticated ? [
          { type: "divider" as const },
          { key: "password", icon: <LockOutlined />, label: <a href="/change-password">修改密码</a> },
          { key: "logout", icon: <LogoutOutlined />, label: "退出登录" },
        ] : []),
      ], onClick: ({ key }) => { if (key === "logout") props.onLogout(); } }} placement="topLeft" trigger={["click"]}>
        <Button className="sidebar-more" icon={<AppstoreOutlined />} block>更多功能</Button>
      </Dropdown>
    </aside>
  );
}
