import { ArrowLeftOutlined } from "@ant-design/icons";
import { Alert, Button, Input, List, message, Modal, Space, Spin, Tabs, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { ApiDocDetail } from "./ApiDocDetail";
import { ApiDocDebugger } from "./ApiDocDebugger";

type SearchData = Awaited<ReturnType<typeof api.searchApiDocs>>;
type Endpoint = SearchData["results"][number];
type Detail = Awaited<ReturnType<typeof api.getApiDocDetail>>;

function apiDocExportUrl(item: Endpoint): string {
  const url = new URL("/api/api-docs/export", window.location.origin);
  url.search = new URLSearchParams({ service: item.service, method: item.method, path: item.path }).toString();
  return url.href;
}

async function copyApiDocUrl(item: Endpoint): Promise<void> {
  const url = apiDocExportUrl(item);
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    else {
      const textarea = document.createElement("textarea");
      textarea.value = url;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("复制失败");
    }
    message.success("接口文档链接已复制");
  } catch {
    message.error("复制失败，请检查浏览器剪贴板权限");
  }
}

export function ApiDocSearch(props: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SearchData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Endpoint>();
  const [detail, setDetail] = useState<Detail>();
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("doc");
  const detailRequest = useRef(0);

  const openDetail = async (item: Endpoint) => {
    const requestId = ++detailRequest.current;
    setSelected(item);
    setActiveTab("doc");
    setDetail(undefined);
    setDetailError("");
    setDetailLoading(true);
    try {
      const result = await api.getApiDocDetail(item.service, item.method, item.path);
      if (requestId === detailRequest.current) setDetail(result);
    } catch (cause) {
      if (requestId === detailRequest.current) setDetailError(cause instanceof Error ? cause.message : "读取接口详情失败");
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    api.searchApiDocs(query).then((result) => {
      if (!cancelled) { setData(result); setError(""); }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "搜索失败");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.open, query]);

  const back = () => { detailRequest.current += 1; setSelected(undefined); setDetail(undefined); };

  return <Modal className={`api-doc-modal${selected ? " is-detail" : ""}`} title={selected ? "接口文档" : "查找后端接口"}
    open={props.open} onCancel={() => { back(); props.onClose(); }} footer={null}
    width={selected ? "calc(100vw - 72px)" : 760} destroyOnHidden>
    {selected ? <div className="api-doc-detail">
      <div className="api-doc-detail-heading">
        <Button icon={<ArrowLeftOutlined />} onClick={back}>返回搜索结果</Button>
        <Tag color="blue">{selected.method}</Tag>
        <Typography.Text copyable strong>{selected.path}</Typography.Text>
        <Typography.Text type="secondary">{selected.service} · {selected.summary || selected.tag}</Typography.Text>
        <Button onClick={() => void copyApiDocUrl(selected)}>复制文档链接</Button>
      </div>
      <div className="api-doc-detail-scroll">
        {detailLoading && <div className="api-doc-loading"><Spin tip="正在加载接口定义" /></div>}
        {detailError && <Alert type="error" showIcon message={detailError} />}
        {detail && <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          { key: "doc", label: "接口文档", children: <ApiDocDetail operation={detail.operation} schemas={detail.schemas} /> },
          { key: "debug", label: "调试接口", children: <ApiDocDebugger key={`${detail.endpoint.service}:${detail.endpoint.path}`} detail={detail} /> },
        ]} />}
      </div>
    </div> : <>
    <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入路径，如 /historyContract/getPageList" allowClear autoFocus />
    {error && <Alert type="error" message={error} showIcon style={{ marginTop: 12 }} />}
    {data?.sources.length === 0 && <Alert type="info" showIcon style={{ marginTop: 12 }} message="尚未配置接口文档源，请在服务端 .env 设置 API_DOC_SOURCES" />}
    {data?.sources.filter((source) => source.error).map((source) =>
      <Alert key={source.name} type="warning" showIcon style={{ marginTop: 10 }} message={`${source.name}：${source.error}`} />
    )}
    {data && <Typography.Text type="secondary" style={{ display: "block", marginTop: 12 }}>
      已索引 {data.total} 个接口，{data.sources.filter((source) => !source.error).length}/{data.sources.length} 个文档源可用。输入路径后显示匹配结果。
    </Typography.Text>}
    <List loading={loading} style={{ maxHeight: 440, overflowY: "auto", marginTop: 8 }} dataSource={data?.results ?? []}
      locale={{ emptyText: query ? "没有匹配的接口" : "请输入接口路径或名称" }}
      renderItem={(item) => <List.Item actions={[
        <Button key="doc" type="link" onClick={() => void openDetail(item)}>查看文档</Button>,
        <Button key="export" type="link" onClick={() => void copyApiDocUrl(item)}>复制文档链接</Button>,
      ]}>
        <List.Item.Meta title={<Space><Tag color="blue">{item.method}</Tag><Typography.Text copyable>{item.path}</Typography.Text></Space>}
          description={`${item.service} · ${item.summary || item.tag}`} />
      </List.Item>}
    />
    </>}
  </Modal>;
}
