import { Alert, App, Button, Form, Input, Typography } from "antd";
import { useState } from "react";
import { workHoursApi, type AuthUser } from "../services/workHoursApi";

export function Login({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="work-hours-auth"><Typography.Title level={3}>登录</Typography.Title>
    <Form layout="vertical" onFinish={async (values: { username: string; password: string }) => {
      setBusy(true); setError("");
      try { onLogin((await workHoursApi.login(values.username, values.password)).user); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
      finally { setBusy(false); }
    }}>
      <Form.Item name="username" label="账号" rules={[{ required: true }]}><Input autoComplete="username" /></Form.Item>
      <Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
      {error && <Alert type="error" showIcon message={error} />}
      <Button block type="primary" htmlType="submit" loading={busy}>登录</Button>
    </Form>
  </div>;
}

export function ChangePassword({ onChanged, initial = false }: { onChanged: (user: AuthUser) => void; initial?: boolean }) {
  const { message } = App.useApp();
  return <div className="work-hours-auth"><Typography.Title level={3}>{initial ? "修改初始密码" : "修改密码"}</Typography.Title>
    <Form layout="vertical" onFinish={async (values: { currentPassword: string; newPassword: string }) => {
      try { onChanged((await workHoursApi.changePassword(values.currentPassword, values.newPassword)).user); message.success("密码已更新"); }
      catch (error) { message.error(error instanceof Error ? error.message : "修改失败"); }
    }}>
      <Form.Item name="currentPassword" label={initial ? "初始密码" : "当前密码"} rules={[{ required: true }]}><Input.Password /></Form.Item>
      <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 6, message: "至少 6 位" }]}><Input.Password /></Form.Item>
      <Button block type="primary" htmlType="submit">修改密码</Button>
    </Form>
  </div>;
}

