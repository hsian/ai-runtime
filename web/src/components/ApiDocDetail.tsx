import { Collapse, Empty, Table, Typography } from "antd";

type DocObject = Record<string, unknown>;
type FieldRow = { key: string; name: string; description: string; type: string; required?: boolean; location?: string };

function object(value: unknown): DocObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DocObject : undefined;
}

function label(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function refName(ref: string): string {
  const name = ref.split("/").pop() ?? ref;
  try { return decodeURIComponent(name).replace(/~1/g, "/").replace(/~0/g, "~"); }
  catch { return name; }
}

function resolveSchema(value: unknown, schemas: DocObject): DocObject | undefined {
  const schema = object(value);
  if (!schema) return undefined;
  const ref = label(schema.$ref);
  return ref ? object(schemas[ref]) ?? schema : schema;
}

function schemaType(value: unknown): string {
  const schema = object(value);
  if (!schema) return "—";
  if (typeof schema.$ref === "string") return refName(schema.$ref);
  if (schema.type === "array") return `${schemaType(schema.items)}[]`;
  const type = label(schema.type) || (schema.properties ? "object" : "—");
  return schema.format ? `${type} (${schema.format})` : type;
}

function schemaRows(value: unknown, schemas: DocObject): FieldRow[] {
  let schema = resolveSchema(value, schemas);
  if (schema?.type === "array") schema = resolveSchema(schema.items, schemas);
  const properties = object(schema?.properties);
  if (!properties) return [];
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  return Object.entries(properties).map(([name, raw]) => {
    const field = object(raw);
    const enumText = Array.isArray(field?.enum) ? `可选值：${field.enum.join("、")}` : "";
    return {
      key: name,
      name,
      description: [label(field?.description) || label(field?.title), enumText].filter(Boolean).join("；") || "—",
      type: schemaType(raw),
      required: required.has(name) || field?.required === true,
    };
  });
}

function expandedModelRef(value: unknown, schemas: DocObject): string | undefined {
  const schema = object(value);
  if (!schema) return undefined;
  if (schema.type === "array") return expandedModelRef(schema.items, schemas);
  const ref = label(schema.$ref);
  return ref && schemaRows(schema, schemas).length > 0 ? ref : undefined;
}

function contentSchema(value: unknown): unknown {
  const record = object(value);
  if (!record) return undefined;
  if (record.schema) return record.schema;
  const content = object(record.content);
  const media = content && (object(content["application/json"]) ?? object(Object.values(content)[0]));
  return media?.schema;
}

function FieldTable(props: { rows: FieldRow[]; showLocation?: boolean; showRequired?: boolean }) {
  if (props.rows.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="文档未声明字段" />;
  return <Table<FieldRow> className="api-doc-table" size="small" bordered pagination={false} rowKey="key" dataSource={props.rows}
    scroll={{ x: 760 }} columns={[
      { title: "参数名称", dataIndex: "name", width: "28%", render: (value: string) => <code>{value}</code> },
      { title: "参数说明", dataIndex: "description" },
      { title: "类型", dataIndex: "type", width: "20%" },
      ...(props.showLocation ? [{ title: "位置", dataIndex: "location" as const, width: 100 }] : []),
      ...(props.showRequired ? [{ title: "必填", dataIndex: "required" as const, width: 72, render: (value: boolean) => value ? "是" : "否" }] : []),
    ]} />;
}

function DocSection(props: { title: string; children: React.ReactNode }) {
  return <section className="api-doc-section"><h3>{props.title}</h3>{props.children}</section>;
}

export function ApiDocDetail(props: { operation: DocObject; schemas: DocObject }) {
  const { operation, schemas } = props;
  const parameters = Array.isArray(operation.parameters) ? operation.parameters.map(object).filter((item): item is DocObject => Boolean(item)) : [];
  const simpleParameters = parameters.filter((item) => item.in !== "body").map((item, index) => ({
    key: `${item.in}-${item.name}-${index}`,
    name: label(item.name) || "—",
    description: label(item.description) || "—",
    type: schemaType(item.schema ?? item),
    location: label(item.in) || "—",
    required: item.required === true,
  }));
  const bodyParameters = parameters.filter((item) => item.in === "body");
  const requestBody = object(operation.requestBody);
  const responses = object(operation.responses) ?? {};
  const responseRows = Object.entries(responses).map(([status, raw]) => ({
    key: status,
    status,
    description: label(object(raw)?.description) || "—",
    type: schemaType(contentSchema(raw)),
  }));
  const success = object(responses["200"] ?? responses["201"] ?? responses.default);
  const responseSchema = contentSchema(success);
  const examples = object(success?.examples);
  const expandedRefs = new Set([
    ...bodyParameters.map((item) => expandedModelRef(item.schema, schemas)),
    expandedModelRef(contentSchema(requestBody), schemas),
    expandedModelRef(responseSchema, schemas),
  ].filter((ref): ref is string => Boolean(ref)));
  const remainingSchemas = Object.entries(schemas).filter(([ref]) => !expandedRefs.has(ref));

  return <div className="api-doc-sections">
    {typeof operation.description === "string" && <Typography.Paragraph>{operation.description}</Typography.Paragraph>}
    {(simpleParameters.length > 0 || (bodyParameters.length === 0 && !requestBody)) &&
      <DocSection title="请求参数"><FieldTable rows={simpleParameters} showLocation showRequired /></DocSection>}
    {(bodyParameters.length > 0 || requestBody) && <DocSection title="请求体">
      {bodyParameters.map((item, index) => <div key={`${item.name}-${index}`}>
        <Typography.Text type="secondary">{label(item.description) || label(item.name) || "body"} · {schemaType(item.schema)}</Typography.Text>
        <FieldTable rows={schemaRows(item.schema, schemas)} showRequired />
      </div>)}
      {requestBody && <>
        {typeof requestBody.description === "string" && <Typography.Paragraph>{requestBody.description}</Typography.Paragraph>}
        <FieldTable rows={schemaRows(contentSchema(requestBody), schemas)} showRequired />
      </>}
    </DocSection>}
    <DocSection title="响应状态">
      <Table className="api-doc-table" size="small" bordered pagination={false} rowKey="key" dataSource={responseRows}
        columns={[
          { title: "状态码", dataIndex: "status", width: 120 },
          { title: "说明", dataIndex: "description" },
          { title: "返回类型", dataIndex: "type", width: "26%" },
        ]} />
    </DocSection>
    <DocSection title="响应参数">
      {responseSchema !== undefined && <Typography.Text type="secondary">{schemaType(responseSchema)}</Typography.Text>}
      <FieldTable rows={schemaRows(responseSchema, schemas)} />
    </DocSection>
    {examples && <DocSection title="响应示例"><pre className="api-doc-example">{JSON.stringify(examples, null, 2)}</pre></DocSection>}
    {remainingSchemas.length > 0 && <DocSection title={`其他数据模型（${remainingSchemas.length}）`}>
      <Collapse items={remainingSchemas.map(([ref, schema]) => ({
        key: ref,
        label: <><code>{refName(ref)}</code> <Typography.Text type="secondary">{label(object(schema)?.description)}</Typography.Text></>,
        children: <FieldTable rows={schemaRows(schema, schemas)} />,
      }))} />
    </DocSection>}
  </div>;
}
