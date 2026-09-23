import { ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";

import { workHoursApi, type AuthUser, type ManagedUser, type WorkProposal, type WorkTask } from "../services/workHoursApi";

const now = new Date();
const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

function Login({ onLogin }: { onLogin: (user: AuthUser) => void }) {
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

function ChangePassword({ onChanged, initial = false }: { onChanged: (user: AuthUser) => void; initial?: boolean }) {
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

function HoursTool({ user }: { user: AuthUser }) {
  const { message, modal } = App.useApp();
  const [month, setMonth] = useState(thisMonth);
  const [target, setTarget] = useState(140);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [proposals, setProposals] = useState<WorkProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    workHoursApi.projects().then(({ projects: items }) => { setProjects(items); setSelected(items.map((item) => item.id)); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "项目读取失败"));
  }, []);
  const proposalMap = useMemo(() => new Map(proposals.map((item) => [`${item.workspaceId}:${item.id}`, item])), [proposals]);
  const total = proposals.reduce((sum, item) => sum + item.hours, 0) + tasks.reduce((sum, task) => sum + (Number(task.currentHours) || 0), 0);
  const generate = async () => {
    setBusy(true); setError(""); setTasks([]); setProposals([]);
    try { const result = await workHoursApi.preview(month, target, selected); setTasks(result.tasks); setProposals(result.proposals); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "预览失败"); }
    finally { setBusy(false); }
  };
  const change = (key: string, field: "hours" | "pages", value: number | null) => {
    if (value === null) return;
    setProposals((items) => items.map((item) => `${item.workspaceId}:${item.id}` === key ? { ...item, [field]: value } : item));
  };
  const apply = () => {
    modal.confirm({ title: `写入 ${proposals.length} 条 TAPD 任务？`, content: `实际工时合计 ${total} 小时。已有填报值不会覆盖。`, okText: "确认写入", cancelText: "取消", onOk: async () => {
      setBusy(true);
      try {
        const result = await workHoursApi.apply(month, selected, proposals.map((item) => ({ ...item, expectedHours: "", expectedPages: "" })));
        const failed = result.results.filter((item) => !item.ok);
        message[failed.length ? "warning" : "success"](`成功 ${result.results.length - failed.length} 条，失败 ${failed.length} 条`);
        await generate();
        if (failed.length) setError(failed.map((item) => `${item.id}: ${item.error}`).join("；"));
      } catch (reason) { setError(reason instanceof Error ? reason.message : "写入失败"); }
      finally { setBusy(false); }
    } });
  };
  return <div className="work-hours-scroll"><div className="work-hours-content">
    <div className="work-hours-toolbar">
      <label>月份 <DatePicker picker="month" format="YYYY年MM月" allowClear={false} value={dayjs(`${month}-01`)} onChange={(date) => { if (date) setMonth(date.format("YYYY-MM")); }} /></label>
      <label>项目 <Select mode="multiple" value={selected} onChange={setSelected} options={projects.map((item) => ({ label: item.name, value: item.id }))} /></label>
      <label>目标工时 <InputNumber min={1} max={744} value={target} onChange={(value) => setTarget(value ?? 140)} /></label>
      <Button icon={<ReloadOutlined />} type="primary" loading={busy} disabled={!selected.length} onClick={() => void generate()}>生成预览</Button>
    </div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError("")} />}
    <div className="work-hours-summary"><strong>{tasks.length}</strong> 个已完成任务 <span>处理人：{user.tapdOwnerName}</span><span>工时合计：<strong>{total}</strong> / {target}</span><span>待写入：{proposals.length}</span></div>
    <Table rowKey={(task) => `${task.workspaceId}:${task.id}`} dataSource={tasks} loading={busy} size="small" pagination={{ pageSize: 20 }} scroll={{ x: 920 }} columns={[
      { title: "项目", dataIndex: "projectName", width: 110 },
      { title: "完成时间", dataIndex: "completed", width: 155 },
      { title: "任务", dataIndex: "name", render: (value: string, task: WorkTask) => <a href={`https://www.tapd.cn/tapd_fe/${task.workspaceId}/task/detail/${task.id}`} target="_blank" rel="noreferrer">{value}</a> },
      { title: "复杂度", width: 80, render: (_: unknown, task: WorkTask) => proposalMap.get(`${task.workspaceId}:${task.id}`)?.score ?? "—" },
      { title: "实际工时", width: 110, render: (_: unknown, task: WorkTask) => { const key = `${task.workspaceId}:${task.id}`, item = proposalMap.get(key); return item ? <InputNumber min={1} max={16} value={item.hours} onChange={(value) => change(key, "hours", value)} /> : task.currentHours || "—"; } },
      { title: "页面数", width: 110, render: (_: unknown, task: WorkTask) => { const key = `${task.workspaceId}:${task.id}`, item = proposalMap.get(key); return item ? <InputNumber min={0} max={100} value={item.pages} onChange={(value) => change(key, "pages", value)} /> : task.currentPages || "—"; } },
    ]} />
    <div className="work-hours-actions"><Button type="primary" icon={<SaveOutlined />} disabled={!proposals.length || total !== target} loading={busy} onClick={apply}>确认写入 TAPD</Button></div>
  </div></div>;
}

function AccountManagement({ user }: { user: AuthUser }) {
  const { message, modal } = App.useApp();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [open, setOpen] = useState(false);
  const [initialPassword, setInitialPassword] = useState("");
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const load = () => workHoursApi.users().then((result) => setUsers(result.users));
  useEffect(() => { void load().catch((reason) => message.error(reason.message)); }, []);
  const showPassword = (password: string) => { setInitialPassword(password); };
  return <div className="work-hours-scroll"><div className="work-hours-content">
    <div className="work-hours-toolbar"><Button type="primary" onClick={() => setOpen(true)}>创建账号</Button></div>
    <Table rowKey="id" size="small" dataSource={users} columns={[
      { title: "账号", dataIndex: "username" }, { title: "姓名", dataIndex: "display_name" },
      { title: "TAPD 处理人", dataIndex: "tapd_owner_name" },
      { title: "权限", dataIndex: "role", render: (role: string) => role === "admin" ? "管理员" : "成员" },
      { title: "状态", dataIndex: "enabled", render: (enabled: number) => enabled ? "启用" : "停用" },
      { title: "操作", render: (_: unknown, row: ManagedUser) => <Space>
        <Button size="small" onClick={() => setEditing(row)}>编辑</Button>
        <Button size="small" onClick={() => modal.confirm({ title: `重置 ${row.username} 的密码？`, onOk: async () => { showPassword((await workHoursApi.resetPassword(row.id)).initialPassword); await load(); } })}>重置密码</Button>
        {row.id !== user.id && <Button size="small" danger={Boolean(row.enabled)} onClick={() => modal.confirm({ title: `${row.enabled ? "停用" : "启用"} ${row.username}？`, onOk: async () => {
          await workHoursApi.updateUser(row.id, { displayName: row.display_name, tapdOwnerName: row.tapd_owner_name, role: row.role, enabled: !row.enabled }); await load();
        } })}>{row.enabled ? "停用" : "启用"}</Button>}
      </Space> },
    ]} />
    <Modal title="创建账号" open={open} footer={null} onCancel={() => setOpen(false)} destroyOnHidden>
      <Form layout="vertical" initialValues={{ role: "member" }} onFinish={async (values) => {
        try { showPassword((await workHoursApi.createUser(values)).initialPassword); setOpen(false); await load(); }
        catch (reason) { message.error(reason instanceof Error ? reason.message : "创建失败"); }
      }}>
        <Form.Item name="username" label="账号" rules={[{ required: true, min: 3 }]}><Input /></Form.Item>
        <Form.Item name="displayName" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="tapdOwnerName" label="TAPD 处理人" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="role" label="权限"><Select options={[{ label: "成员", value: "member" }, { label: "管理员", value: "admin" }]} /></Form.Item>
        <Button type="primary" htmlType="submit">创建</Button>
      </Form>
    </Modal>
    <Modal title={`编辑 ${editing?.username || ""}`} open={Boolean(editing)} footer={null} onCancel={() => setEditing(null)} destroyOnHidden>
      {editing && <Form layout="vertical" initialValues={{ displayName: editing.display_name, tapdOwnerName: editing.tapd_owner_name, role: editing.role }} onFinish={async (values) => {
        try { await workHoursApi.updateUser(editing.id, { ...values, enabled: Boolean(editing.enabled) }); setEditing(null); await load(); message.success("已保存"); }
        catch (reason) { message.error(reason instanceof Error ? reason.message : "保存失败"); }
      }}>
        <Form.Item name="displayName" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="tapdOwnerName" label="TAPD 处理人" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="role" label="权限"><Select disabled={editing.id === user.id} options={[{ label: "成员", value: "member" }, { label: "管理员", value: "admin" }]} /></Form.Item>
        <Button type="primary" htmlType="submit">保存</Button>
      </Form>}
    </Modal>
    <Modal title="初始密码" open={Boolean(initialPassword)} onOk={() => setInitialPassword("")} onCancel={() => setInitialPassword("")} cancelButtonProps={{ style: { display: "none" } }}>
      <Typography.Paragraph copyable>{initialPassword}</Typography.Paragraph>
      <Typography.Text type="secondary">仅显示本次。首次登录后需要修改密码。</Typography.Text>
    </Modal>
  </div></div>;
}

export default function WorkHoursPage({ admin = false, passwordPage = false }: { admin?: boolean; passwordPage?: boolean }) {
  const [user, setUser] = useState<AuthUser | null>();
  useEffect(() => { workHoursApi.me().then((result) => setUser(result.user)).catch(() => setUser(null)); }, []);
  const title = admin ? "账号管理" : passwordPage ? "修改密码" : "智能填写工时";
  const subtitle = admin ? "管理账号与 TAPD 处理人" : passwordPage ? "更新当前账号密码" : "按任务复杂度生成工时与页面数方案";
  return <div className="work-hours-page"><header className="analytics-header work-hours-header">
    <div><Typography.Title level={3}>{title}</Typography.Title><Typography.Text type="secondary">{subtitle}</Typography.Text></div>
    </header>
    {user === undefined ? null : user === null ? <Login onLogin={setUser} /> : user.mustChangePassword || passwordPage ? <ChangePassword initial={user.mustChangePassword} onChanged={(updated) => { setUser(updated); if (passwordPage) window.location.assign("/"); }} /> : admin && !user.permissions.includes("users.manage") ? <div className="work-hours-auth"><Alert type="error" message="没有账号管理权限" /></div> : admin ? <AccountManagement user={user} /> : <HoursTool user={user} />}
  </div>;
}
