import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Card, Descriptions, Form, Input, Tag } from "antd";
import { useAuth } from "../auth";
import { errorMessage } from "../api";
import { displayNameError } from "../accountValidation";
import { ErrorState, LoadingState, PageHeading } from "../components";
import { useResource } from "../useResource";
import { PasswordChangeCard } from "./PasswordChangeCard";
import { AccountAvatar } from "../PersonalAvatar";
import { AvatarEditor } from "./AvatarEditor";

export function ProfilePage() {
  const auth = useAuth();
  const { user, readProfile, updateProfile } = auth;
  const resource = useResource((signal) => readProfile(signal), [user?.id, auth.userGeneration, readProfile]);
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{ displayName: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    const reset = () => {
      submission.current?.abort();
      submission.current = null;
      form.resetFields();
      setBusy(false); setError(null);
    };
    const unsubscribe = auth.subscribeAuthentication(reset);
    return () => {
      mounted.current = false;
      unsubscribe();
      submission.current?.abort();
    };
  }, [form, auth.subscribeAuthentication]);

  useEffect(() => {
    if (resource.data) form.setFieldsValue({ displayName: resource.data.displayName });
  }, [form, resource.data]);

  async function submit(values: { displayName: string }) {
    if (submission.current) return;
    const ticket = auth.captureAccountRequest();
    if (!ticket) return;
    const controller = new AbortController();
    submission.current = controller;
    const current = () => mounted.current && !controller.signal.aborted &&
      submission.current === controller && auth.isCurrentAccountRequest(ticket);
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProfile(values.displayName.trim(), controller.signal);
      if (!current()) return;
      form.setFieldsValue({ displayName: updated.displayName });
      message.success("昵称已更新");
    } catch (err) {
      if (current() && !(err instanceof DOMException && err.name === "AbortError"))
        setError(errorMessage(err));
    } finally {
      if (current()) {
        submission.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <div className="page-container">
      <PageHeading title="个人中心" section="我的账号" description="查看账号资料，设置昵称与个人头像。" />
      {resource.loading ? <LoadingState /> : resource.error ? (
        <ErrorState error={resource.error} retry={resource.retry} />
      ) : user && (
        <div className="profile-layout">
          <Card title="账号资料" className="profile-card">
            <div className="profile-identity">
              <AccountAvatar size={64} testId="profile-avatar" />
              <div><h2>{user.displayName}</h2><Tag color={user.role === "ADMIN" ? "blue" : "default"}>{user.role === "ADMIN" ? "活动组织者" : "活动参与者"}</Tag></div>
            </div>
            <Descriptions column={1} items={[
              { key: "username", label: "账号", children: user.username },
              { key: "displayName", label: "当前昵称", children: <span data-testid="profile-display-name">{user.displayName}</span> },
            ]} />
            <p className="profile-note">账号用于登录，创建后不能修改。</p>
          </Card>
          <Card title="修改昵称" className="profile-card">
            <p className="profile-form-intro">昵称用于账号菜单和活动报名名单。</p>
            {error && <Alert className="form-alert" type="error" showIcon title={error} />}
            <Form form={form} layout="vertical" onFinish={submit} requiredMark={false} disabled={busy}>
              <Form.Item name="displayName" label="昵称" extra="1–40 位，不包含控制字符。" rules={[
                { validator: (_, value: string = "") => {
                  const message = displayNameError(value);
                  return message ? Promise.reject(new Error(message)) : Promise.resolve();
                } },
              ]}>
                <Input autoComplete="nickname" placeholder="输入你的昵称" maxLength={80} />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={busy} aria-label="保存昵称" aria-busy={busy}>保存昵称</Button>
            </Form>
          </Card>
          <AvatarEditor />
          <PasswordChangeCard />
        </div>
      )}
    </div>
  );
}
