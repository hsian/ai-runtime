import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles/global.css";

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
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>
);
