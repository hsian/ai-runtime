import { DownloadOutlined, ExperimentOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Space, Table, Tag, Typography } from "antd";

import { api } from "../services/api";
import type { TestCaseDocument } from "../types";

export function TestCaseResult(props: { jobId: string; document: TestCaseDocument }) {
  const assessment = props.document.implementationAssessment;
  const assessmentType = assessment?.recommendedResult === "已实现"
    ? "success"
    : assessment?.recommendedResult === "部分实现" || assessment?.recommendedResult === "无法判断"
      ? "warning"
      : "error";

  return (
    <Card
      className="result-card test-case-result"
      title={<Space><ExperimentOutlined />测试用例 <Tag>{props.document.cases.length} 条</Tag></Space>}
      extra={<Button type="primary" icon={<DownloadOutlined />} href={api.testCaseDownloadUrl(props.jobId)}>下载 Excel</Button>}
    >
      <Typography.Paragraph type="secondary">{props.document.moduleName} · {props.document.functionDescription}</Typography.Paragraph>
      {assessment && (
        <Alert
          className="test-case-assessment"
          type={assessmentType}
          showIcon
          message={<Space>代码分析推荐结果<Tag>{assessment.recommendedResult}</Tag></Space>}
          description={(
            <Space direction="vertical" size={4}>
              <Typography.Text>{assessment.summary}</Typography.Text>
              {assessment.evidence.length > 0 && <Typography.Text type="secondary">代码依据：{assessment.evidence.join("；")}</Typography.Text>}
              {assessment.gaps.length > 0 && <Typography.Text type="secondary">缺口/待验证：{assessment.gaps.join("；")}</Typography.Text>}
              <Typography.Text type="secondary">仅供测试参考，实际结果请以测试人员执行验证为准。</Typography.Text>
            </Space>
          )}
        />
      )}
      <Table
        size="small"
        rowKey="caseNumber"
        dataSource={props.document.cases}
        pagination={props.document.cases.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
        scroll={{ x: 1500 }}
        columns={[
          { title: "编号", dataIndex: "caseNumber", width: 70, fixed: "left" },
          { title: "优先级", dataIndex: "priority", width: 80, render: (value: string) => <Tag color={value === "高" ? "red" : value === "中" ? "orange" : "blue"}>{value}</Tag> },
          { title: "一级模块", dataIndex: "levelOneModule", width: 130 },
          { title: "二级模块", dataIndex: "levelTwoModule", width: 130 },
          { title: "需求/功能点", dataIndex: "requirementPoint", width: 180 },
          { title: "测试要点", dataIndex: "testPoint", width: 180 },
          { title: "前置条件/输入数据", dataIndex: "preconditions", width: 220 },
          { title: "操作步骤", dataIndex: "steps", width: 300, render: (steps: string[]) => <ol className="test-case-steps">{steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol> },
          { title: "预期结果", dataIndex: "expectedResult", width: 240 },
        ]}
      />
    </Card>
  );
}
