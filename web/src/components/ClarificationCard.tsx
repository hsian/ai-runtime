import { QuestionCircleOutlined, PaperClipOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Input, Radio, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ClarificationAnswer, ClarificationQuestion } from "../types";

const OTHER_VALUE = "__other__";

export function ClarificationCard(props: {
  questions: ClarificationQuestion[];
  busy: boolean;
  onSubmit: (answers: ClarificationAnswer[], note: string, files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const questionSetKey = props.questions.map((question) => `${question.id}:${question.question}`).join("|");

  useEffect(() => {
    setValues({});
    setOtherValues({});
    setNote("");
    setFiles([]);
  }, [questionSetKey]);

  const answers = useMemo(() => props.questions.map((question) => ({
    questionId: question.id,
    question: question.question,
    value: values[question.id] === OTHER_VALUE
      ? (otherValues[question.id] ?? "").trim()
      : (values[question.id] ?? "").trim(),
  })).filter((answer) => Boolean(answer.value)), [otherValues, props.questions, values]);
  const answeredIds = new Set(answers.map((answer) => answer.questionId));
  const complete = props.questions.every((question) => !question.required || answeredIds.has(question.id));

  return (
    <Card
      className="clarification-card"
      title={<Space><QuestionCircleOutlined />Agent 需要确认</Space>}
    >
      <Alert
        type="info"
        showIcon
        message="回答下面的业务问题后，Agent 会继续分析并生成修改方案。"
      />
      <div className="clarification-questions">
        {props.questions.map((question, index) => (
          <div className="clarification-question" key={question.id}>
            <Typography.Text strong>{index + 1}. {question.question}</Typography.Text>
            {question.reason && <Typography.Text className="clarification-reason" type="secondary">需要确认：{question.reason}</Typography.Text>}
            {question.type === "single_choice" ? (
              <Radio.Group
                value={values[question.id]}
                onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}
              >
                <Space direction="vertical">
                  {(question.options ?? []).map((option) => (
                    <Radio value={option} key={option}>
                      {option}
                      {option === question.recommendedOption && <Tag color="blue">推荐</Tag>}
                    </Radio>
                  ))}
                  {question.allowOther !== false && <Radio value={OTHER_VALUE}>其他</Radio>}
                </Space>
              </Radio.Group>
            ) : (
              <Input.TextArea
                value={values[question.id] ?? ""}
                autoSize={{ minRows: 2, maxRows: 5 }}
                maxLength={5_000}
                placeholder="请输入你的回答"
                onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}
              />
            )}
            {question.type === "single_choice" && values[question.id] === OTHER_VALUE && (
              <Input
                value={otherValues[question.id] ?? ""}
                maxLength={5_000}
                placeholder="请输入其他答案"
                onChange={(event) => setOtherValues((current) => ({ ...current, [question.id]: event.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      <Input.TextArea
        value={note}
        autoSize={{ minRows: 2, maxRows: 5 }}
        maxLength={5_000}
        placeholder="补充说明（可选）"
        onChange={(event) => setNote(event.target.value)}
      />
      {files.length > 0 && (
        <div className="clarification-files">
          {files.map((file, index) => (
            <Tag
              closable
              key={`${file.name}-${index}`}
              onClose={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
            >
              {file.name}
            </Tag>
          ))}
        </div>
      )}
      <div className="clarification-actions">
        <input
          ref={inputRef}
          hidden
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => {
            const images = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
            setFiles((current) => [...current, ...images]);
            event.target.value = "";
          }}
        />
        <Button icon={<PaperClipOutlined />} onClick={() => inputRef.current?.click()}>追加截图</Button>
        <Space>
          <Button
            disabled={props.busy}
            onClick={() => props.onSubmit(
              props.questions.map((question) => ({
                questionId: question.id,
                question: question.question,
                value: "这项不需要由我决定，请根据仓库中的现有实现自行判断，并保持已有行为一致。",
              })),
              note.trim(),
              files
            )}
          >
            按现有实现自行判断
          </Button>
          <Button
            type="primary"
            loading={props.busy}
            disabled={!complete}
            onClick={() => props.onSubmit(answers, note.trim(), files)}
          >
            按以上回答继续分析
          </Button>
        </Space>
      </div>
    </Card>
  );
}
