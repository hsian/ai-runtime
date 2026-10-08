import { ArrowLeftOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, App as AntApp, Button, Input, List, Modal, Space, Spin, Tabs, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { ApiDocDetail } from "./ApiDocDetail";
import { ApiDocDebugger } from "./ApiDocDebugger";

type SearchData = Awaited<ReturnType<typeof api.searchApiDocs>>;
type Endpoint = SearchData["results"][number];
type Detail = Awaited<ReturnType<typeof api.getApiDocDetail>>;

function apiDocJsonUrl(item: Endpoint): string {
  const url = new URL("/api/api-docs/detail", window.location.origin);
  url.search = new URLSearchParams({ service: item.service, method: item.method, path: item.path }).toString();
  return url.href;
}

export function ApiDocSearch(props: { open: boolean; onClose: () => void; initialQuery?: string }) {
  const { message, modal } = AntApp.useApp();
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [data, setData] = useState<SearchData>();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Endpoint>();
  const [detail, setDetail] = useState<Detail>();
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("doc");
  const detailRequest = useRef(0);
  const searchRequest = useRef(0);

  const handleCopyDocUrl = async (item: Endpoint) => {
    const url = apiDocJsonUrl(item);
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        message.success("接口 JSON 文档地址已复制");
        return;
      } catch { /* 浏览器拒绝写入时显示可手动复制的地址 */ }
    }
    modal.info({
      title: "请手动复制接口 JSON 文档地址",
      content: <div>
        <Typography.Paragraph>浏览器未允许自动复制。点击下方地址框，按 Ctrl+A、Ctrl+C 复制。</Typography.Paragraph>
        <textarea value={url} readOnly rows={4} autoFocus
          ref={(element) => element?.select()}
          onFocus={(event) => event.currentTarget.select()}
          style={{ width: "100%", boxSizing: "border-box" }} />
      </div>,
    });
  };

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
    const requestId = ++searchRequest.current;
    setLoading(true);
    api.searchApiDocs(query).then((result) => {
      if (!cancelled && requestId === searchRequest.current) { setData(result); setError(""); }
    }).catch((cause) => {
      if (!cancelled && requestId === searchRequest.current) setError(cause instanceof Error ? cause.message : "搜索失败");
    }).finally(() => { if (!cancelled && requestId === searchRequest.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.open, query]);

  const back = () => { detailRequest.current += 1; setSelected(undefined); setDetail(undefined); };

  const refreshDocs = async () => {
    if (refreshing) return;
    const searchId = ++searchRequest.current;
    const detailId = ++detailRequest.current;
    setRefreshing(true);
    setLoading(false);
    setError("");
    if (selected) { setDetailLoading(true); setDetailError(""); }
    try {
      const result = await api.refreshApiDocs(query);
      if (searchId === searchRequest.current) setData(result);
      if (selected && detailId === detailRequest.current) {
        try {
          const nextDetail = await api.getApiDocDetail(selected.service, selected.method, selected.path);
          if (detailId === detailRequest.current) setDetail(nextDetail);
        } catch (cause) {
          if (detailId === detailRequest.current) {
            setDetail(undefined);
            setDetailError(cause instanceof Error ? cause.message : "刷新接口详情失败");
          }
        }
      }
      if (result.sources.some((source) => source.error)) message.warning("刷新完成，部分文档源读取失败");
      else message.success("接口文档已刷新");
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "刷新接口文档失败";
      if (selected) setDetailError(text);
      else setError(text);
    } finally {
      if (detailId === detailRequest.current) setDetailLoading(false);
      setRefreshing(false);
    }
  };

  return <Modal rootClassName={selected ? "api-doc-detail-root" : undefined}
    className={`api-doc-modal${selected ? " is-detail" : ""}`} title={selected ? "接口文档" : "查找后端接口"}
    open={props.open} onCancel={() => { back(); props.onClose(); }} footer={null}
    width={selected ? "calc(100vw - 72px)" : 760} destroyOnHidden>
    {selected ? <div className="api-doc-detail">
      <div className="api-doc-detail-heading">
        <Button icon={<ArrowLeftOutlined />} onClick={back}>返回搜索结果</Button>
        <Tag color="blue">{selected.method}</Tag>
        <Typography.Text copyable strong>{selected.path}</Typography.Text>
        <Typography.Text type="secondary">{selected.service} · {selected.summary || selected.tag}</Typography.Text>
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refreshDocs()}>刷新文档</Button>
        <Button onClick={() => void handleCopyDocUrl(selected)}>复制 JSON 文档地址</Button>
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
    <div style={{ display: "flex", gap: 8 }}>
      <Input.Search style={{ flex: 1, minWidth: 0 }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入路径，如 /historyContract/getPageList" allowClear autoFocus />
      <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refreshDocs()}>刷新文档</Button>
    </div>
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
        <Button key="export" type="link" onClick={() => void handleCopyDocUrl(item)}>复制 JSON 文档地址</Button>,
      ]}>
        <List.Item.Meta title={<Space><Tag color="blue">{item.method}</Tag><Typography.Text copyable>{item.path}</Typography.Text></Space>}
          description={`${item.service} · ${item.summary || item.tag}`} />
      </List.Item>}
    />
    </>}
  </Modal>;
}
