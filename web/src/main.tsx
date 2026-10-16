import { App as AntApp, ConfigProvider, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import React from "react";
import ReactDOM from "react-dom/client";

import "./styles/global.css";

const normalizedPath = window.location.pathname.replace(/\/+$/, "") || "/";
if (normalizedPath === "/docs") document.title = "接口文档";
const App = React.lazy(() => import("./App"));
const AnalyticsPage = React.lazy(() => import("./components/AnalyticsPage"));
const WorkHoursPage = React.lazy(() => import("./components/WorkHoursPage"));
const ApiDocsPage = React.lazy(() => import("./components/ApiDocsPage"));
const WorkbenchPage = React.lazy(() => import("./components/WorkbenchPage"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#315cf4",
          colorInfo: "#315cf4",
          colorSuccess: "#12a271",
          colorWarning: "#e18b25",
          colorError: "#dc4c4c",
          borderRadius: 10,
          colorBgLayout: "#f4f6fa",
          fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
        },
      }}
    >
      <AntApp>
        <React.Suspense fallback={<div role="status" style={{ padding: 40, textAlign: "center" }}><Spin /><p>正在加载页面…</p></div>}>
          {normalizedPath === "/workbench" ? (
            <WorkbenchPage />
          ) : normalizedPath === "/docs" ? (
            <ApiDocsPage />
          ) : normalizedPath === "/stats" ? (
            <AnalyticsPage />
          ) : normalizedPath === "/work-hours" || normalizedPath === "/account-management" || normalizedPath === "/change-password" ? (
            <WorkHoursPage admin={normalizedPath === "/account-management"} passwordPage={normalizedPath === "/change-password"} />
          ) : <App />}
        </React.Suspense>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>
);
