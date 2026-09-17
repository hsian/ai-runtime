import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  ReloadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Empty, Progress, Segmented, Select, Skeleton, Statistic, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import { api } from "../services/api";
import type { AnalyticsBreakdownItem, AnalyticsData, CodeChangeAnalytics } from "../types";

function formatDuration(value: number): string {
  if (!value) return "—";
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))} 秒`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} 分钟`;
  return `${Math.round(value / 360_000) / 10} 小时`;
}

function breakdownColumns() {
  return [
    { title: "分类", dataIndex: "label", key: "label" },
    { title: "任务数", dataIndex: "total", key: "total", width: 82, align: "right" as const },
    { title: "完成", dataIndex: "completed", key: "completed", width: 72, align: "right" as const },
    { title: "失败", dataIndex: "failed", key: "failed", width: 72, align: "right" as const },
    {
      title: "成功率",
      dataIndex: "successRate",
      key: "successRate",
      width: 128,
      render: (value: number) => <Progress percent={value} size="small" status={value < 70 ? "exception" : "normal"} />,
    },
  ];
}

function TrendChart({ data }: { data: AnalyticsData["daily"] }) {
  const maximum = Math.max(1, ...data.map((item) => item.total));
  const labelEvery = data.length <= 7 ? 1 : data.length <= 30 ? 5 : 15;
  return (
    <div className="analytics-trend" aria-label="任务趋势图">
      {data.map((item, index) => {
        const other = Math.max(0, item.total - item.completed - item.failed - item.cancelled);
        const height = item.total === 0 ? 2 : Math.max(8, (item.total / maximum) * 100);
        const share = (value: number) => item.total > 0 ? `${(value / item.total) * 100}%` : "0%";
        return (
          <div className="analytics-trend-day" key={item.date} title={`${item.date}：${item.total} 个任务，完成 ${item.completed}，失败 ${item.failed}，取消 ${item.cancelled}`}>
            <div className="analytics-trend-track">
              <div className="analytics-trend-bar" style={{ height: `${height}%` }}>
                {other > 0 && <span className="is-other" style={{ height: share(other) }} />}
                {item.cancelled > 0 && <span className="is-cancelled" style={{ height: share(item.cancelled) }} />}
                {item.failed > 0 && <span className="is-failed" style={{ height: share(item.failed) }} />}
                {item.completed > 0 && <span className="is-completed" style={{ height: share(item.completed) }} />}
              </div>
            </div>
            <span>{index % labelEvery === 0 || index === data.length - 1 ? item.date.slice(5) : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState<string>();
  const [data, setData] = useState<AnalyticsData>();
  const [codeChanges, setCodeChanges] = useState<CodeChangeAnalytics>();
  const [loading, setLoading] = useState(true);
  const [codeLoading, setCodeLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    document.title = "内部统计 · AI Runtime";
    return () => { document.title = "AI Runtime"; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    api.analytics(days, projectId)
      .then((result) => { if (active) setData(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "统计数据读取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, projectId, refreshKey]);

  useEffect(() => {
    let active = true;
    setCodeLoading(true);
    setCodeChanges(undefined);
    api.codeChangeAnalytics(days, projectId)
      .then((result) => { if (active) setCodeChanges(result); })
      .catch(() => { if (active) setCodeChanges(undefined); })
      .finally(() => { if (active) setCodeLoading(false); });
    return () => { active = false; };
  }, [days, projectId, refreshKey]);

  const maxFailureCount = useMemo(() => Math.max(1, ...(data?.failures.map((item) => item.count) ?? [1])), [data]);
  const columns = useMemo(() => breakdownColumns(), []);

  return (
    <div className="analytics-page">
      <header className="analytics-header">
        <div>
          <Typography.Title level={3}>内部统计</Typography.Title>
          <Typography.Text type="secondary">AI Runtime 使用情况与异常概览</Typography.Text>
        </div>
        <div className="analytics-filters">
          <Select
            value={projectId || "all"}
            onChange={(value) => setProjectId(value === "all" ? undefined : value)}
            options={[
              { value: "all", label: "全部项目" },
              ...(data?.availableProjects.map((project) => ({ value: project.id, label: project.name })) ?? []),
            ]}
          />
          <Segmented<number> value={days} options={[{ label: "7 天", value: 7 }, { label: "30 天", value: 30 }, { label: "90 天", value: 90 }]} onChange={setDays} />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => setRefreshKey((value) => value + 1)}>刷新</Button>
          <Button icon={<ArrowLeftOutlined />} href="/">返回工作台</Button>
        </div>
      </header>

      <main className="analytics-main">
        {error && <Alert type="error" showIcon message="统计数据读取失败" description={error} />}
        {loading && !data ? <Skeleton active paragraph={{ rows: 12 }} /> : data && (
          <>
            <section className="analytics-stat-grid">
              <Card><Statistic title={`最近 ${days} 天任务`} value={data.overview.total} prefix={<CodeOutlined />} /></Card>
              <Card><Statistic title="成功率" value={data.overview.successRate} suffix="%" prefix={<CheckCircleOutlined />} /></Card>
              <Card><Statistic title="平均处理耗时" value={formatDuration(data.overview.averageDurationMs)} prefix={<ClockCircleOutlined />} /></Card>
              <Card><Statistic title="当前处理中 / 排队" value={`${data.overview.active} / ${data.overview.pending}`} /></Card>
            </section>

            <section className="analytics-grid analytics-grid-wide">
              <Card title="使用趋势" extra={<span className="analytics-legend"><i className="is-completed" />完成 <i className="is-failed" />失败 <i className="is-cancelled" />取消 <i className="is-other" />其他</span>}>
                <TrendChart data={data.daily} />
              </Card>
              <Card title="任务结果">
                <div className="analytics-result-list">
                  <div><span>已完成</span><strong>{data.overview.completed}</strong></div>
                  <div><span>失败</span><strong>{data.overview.failed}</strong></div>
                  <div><span>用户取消</span><strong>{data.overview.cancelled}</strong></div>
                </div>
              </Card>
            </section>

            <section className="analytics-grid">
              <Card title="任务类型">
                <Table<AnalyticsBreakdownItem> rowKey="key" size="small" pagination={false} columns={columns} dataSource={data.taskModes} />
              </Card>
              <Card title="项目分布">
                <Table<AnalyticsBreakdownItem> rowKey="key" size="small" pagination={false} columns={columns} dataSource={data.projects} />
              </Card>
            </section>

            <section className="analytics-grid analytics-grid-code">
              <Card title="代码改动" extra={codeChanges && codeChanges.measuredTaskCount < codeChanges.taskCount ? <Tag color="gold">部分提交不可读取</Tag> : undefined}>
                {codeLoading ? <Skeleton active paragraph={{ rows: 2 }} /> : codeChanges ? (
                  <div className="analytics-code-stats">
                    <Statistic title="产生代码的任务" value={codeChanges.taskCount} />
                    <Statistic title="修改文件" value={codeChanges.fileCount} suffix={<small>平均 {codeChanges.averageFiles}</small>} />
                    <Statistic title="代码增删" value={`+${codeChanges.additions} / −${codeChanges.deletions}`} />
                    <Statistic title="建议研发关注" value={codeChanges.attentionTaskCount} suffix="个任务" />
                  </div>
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="代码改动统计暂不可用" />}
              </Card>
              <Card title="失败分析">
                {data.failures.length > 0 ? (
                  <div className="analytics-failures">
                    {data.failures.map((item) => (
                      <div key={item.category}>
                        <span>{item.category}</span>
                        <Progress percent={Math.round((item.count / maxFailureCount) * 100)} showInfo={false} status="exception" />
                        <strong>{item.count}</strong>
                      </div>
                    ))}
                  </div>
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围内没有失败任务" />}
              </Card>
            </section>

            <Card title="最近异常" extra={<Typography.Text type="secondary">不展示需求正文和上传内容</Typography.Text>}>
              <Table
                rowKey="jobId"
                size="small"
                pagination={false}
                dataSource={data.recentAnomalies}
                locale={{ emptyText: "当前范围内没有异常任务" }}
                columns={[
                  { title: "时间", dataIndex: "time", width: 170, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
                  { title: "项目", dataIndex: "projectName", width: 160 },
                  { title: "任务", dataIndex: "jobId", width: 110, render: (value: string) => <code>{value.slice(0, 8)}</code> },
                  { title: "类型", dataIndex: "category", width: 120 },
                  { title: "状态", dataIndex: "status", width: 90, render: (value: string) => <Tag color={value === "failed" ? "red" : "default"}>{value === "failed" ? "失败" : "已取消"}</Tag> },
                  { title: "摘要", dataIndex: "message", ellipsis: true, render: (value: string) => <span title={value}>{value}</span> },
                ]}
              />
            </Card>

            <footer className="analytics-footer"><WarningOutlined /> 数据统计基于当前保留的任务记录，已清理的历史任务不会计入。</footer>
          </>
        )}
      </main>
    </div>
  );
}
