import { CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined, StopOutlined } from "@ant-design/icons";
import { Drawer, Empty, Select, Space, Spin, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import { api } from "../services/api";
import type { OperationLogEntry } from "../types";

const actionLabels: Record<string, string> = {
  job_submit: "提交任务",
  question_execute: "项目问答",
  plan_generate: "生成方案",
  plan_confirm: "确认执行",
  job_execute: "代码任务",
  agent_execute: "Agent 执行",
  job_cancel: "取消任务",
  job_delete: "删除任务",
  git_commit: "提交代码",
  git_merge: "合并代码",
  merge_request_create: "创建 MR",
  release_merge: "发版分支合并",
  git_revert: "撤回提交",
  merge_discard: "放弃合并",
  tapd_bug_create: "创建 TAPD Bug",
};

const statusMeta = {
  started: { label: "开始", color: "processing", icon: <ClockCircleOutlined /> },
  success: { label: "成功", color: "success", icon: <CheckCircleOutlined /> },
  failed: { label: "失败", color: "error", icon: <CloseCircleOutlined /> },
  cancelled: { label: "取消", color: "default", icon: <StopOutlined /> },
} as const;

function todayKey(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function OperationLogDrawer(props: { open: boolean; onClose: () => void }) {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState(todayKey);
  const [entries, setEntries] = useState<OperationLogEntry[]>([]);
  const [status, setStatus] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setLoading(true);
    void api.operationLogDates()
      .then((items) => {
        setDates(items);
        const selected = items[0] || todayKey();
        setDate(selected);
        return api.operationLogs(selected);
      })
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [props.open]);

  const filtered = useMemo(() => status ? entries.filter((entry) => entry.status === status) : entries, [entries, status]);
  const changeDate = async (value: string) => {
    setDate(value);
    setLoading(true);
    try {
      setEntries(await api.operationLogs(value));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Drawer title="操作日志" open={props.open} onClose={props.onClose} width={760}>
      <Space className="log-filters" wrap>
        <Select value={date} style={{ width: 150 }} options={(dates.length ? dates : [date]).map((item) => ({ label: item, value: item }))} onChange={(value) => void changeDate(value)} />
        <Select
          allowClear
          placeholder="全部状态"
          style={{ width: 130 }}
          value={status}
          onChange={setStatus}
          options={Object.entries(statusMeta).map(([value, item]) => ({ value, label: item.label }))}
        />
        <Typography.Text type="secondary">仅展示当前匿名终端产生的记录</Typography.Text>
      </Space>
      <Spin spinning={loading}>
        <Table
          rowKey={(entry) => `${entry.time}-${entry.action}-${entry.jobId ?? ""}`}
          dataSource={filtered}
          pagination={{ pageSize: 15, showSizeChanger: false }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当天没有操作记录" /> }}
          columns={[
            {
              title: "时间",
              dataIndex: "time",
              width: 155,
              render: (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false }),
            },
            {
              title: "操作",
              dataIndex: "action",
              width: 130,
              render: (value: string) => actionLabels[value] || value,
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 90,
              render: (value: OperationLogEntry["status"]) => {
                const meta = statusMeta[value];
                return <Tag color={meta.color} icon={meta.icon}>{meta.label}</Tag>;
              },
            },
            {
              title: "详情",
              render: (_value, entry) => (
                <div className="log-detail">
                  <span>{entry.error || entry.message || entry.targetBranch || entry.branch || "—"}</span>
                  {entry.jobId && <code>Job {entry.jobId.slice(0, 8)}</code>}
                </div>
              ),
            },
          ]}
        />
      </Spin>
    </Drawer>
  );
}
