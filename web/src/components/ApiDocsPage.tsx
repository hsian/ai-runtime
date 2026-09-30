import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Input, message } from "antd";
import { useEffect, useState } from "react";
import { api } from "../services/api";
import { ApiDocSearch } from "./ApiDocSearch";

type SearchData = Awaited<ReturnType<typeof api.searchApiDocs>>;

export default function ApiDocsPage() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [resultsOpen, setResultsOpen] = useState(false);
  const [data, setData] = useState<SearchData>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showSourceErrors, setShowSourceErrors] = useState(false);
  const failedSources = data?.sources.filter((source) => source.error) ?? [];

  useEffect(() => {
    let cancelled = false;
    api.searchApiDocs("").then((result) => {
      if (!cancelled) { setData(result); setError(""); }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "读取接口文档失败");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const search = (value: string) => {
    const nextQuery = value.trim();
    if (!nextQuery) return;
    setSubmittedQuery(nextQuery);
    setResultsOpen(true);
  };

  const refreshDocs = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      const result = await api.refreshApiDocs("");
      setData(result);
      setShowSourceErrors(false);
      if (result.sources.some((source) => source.error)) message.warning("刷新完成，部分文档源读取失败");
      else message.success("接口文档已刷新");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "刷新接口文档失败");
    } finally {
      setRefreshing(false);
    }
  };

  return <main className="api-doc-page">
    <div className="api-doc-page-content">
      <div className="api-doc-page-heading">
        <div>
          <h1>查找后端接口</h1>
          <p>搜索接口路径或名称，快速查看参数、响应与调试信息。</p>
        </div>
        <Button className="api-doc-page-refresh" type="text" icon={<ReloadOutlined />} loading={refreshing} disabled={loading} onClick={() => void refreshDocs()}>刷新文档</Button>
      </div>
      <Input
        className="api-doc-page-search"
        size="large"
        aria-label="搜索接口文档"
        placeholder="输入路径，如 /historyContract/getPageList"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onPressEnter={() => search(query)}
        suffix={<Button type="text" icon={<SearchOutlined />} aria-label="搜索" onClick={() => search(query)} />}
        allowClear
        autoFocus
      />
      <div className="api-doc-page-status">
        {loading ? <span>正在读取接口索引...</span> : data && <>
          <span className="api-doc-page-stat">已索引 <strong>{data.total}</strong> 个接口</span>
          <span className={`api-doc-page-stat api-doc-page-source-stat${failedSources.length ? " has-error" : ""}`}>
            <span className="api-doc-page-status-dot" aria-hidden="true" />
            {data.sources.length - failedSources.length}/{data.sources.length} 个文档源可用
          </span>
          {failedSources.length > 0 && <Button type="link" size="small" aria-expanded={showSourceErrors} onClick={() => setShowSourceErrors((value) => !value)}>
            {showSourceErrors ? "收起异常源" : `查看异常源 (${failedSources.length})`}
          </Button>}
        </>}
      </div>
      {error && <Alert className="api-doc-page-alert" type="error" showIcon message={error} />}
      {data?.sources.length === 0 && <Alert className="api-doc-page-alert" type="info" showIcon message="尚未配置接口文档源，请在服务端 .env 设置 API_DOC_SOURCES" />}
      {showSourceErrors && failedSources.map((source) =>
        <Alert className="api-doc-page-alert" key={source.name} type="warning" showIcon message={`${source.name}：${source.error}`} />
      )}
    </div>
    {resultsOpen && <ApiDocSearch open initialQuery={submittedQuery} onClose={() => setResultsOpen(false)} />}
  </main>;
}
