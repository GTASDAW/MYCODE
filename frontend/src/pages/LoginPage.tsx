import { useEffect, useRef, useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import {
  ArrowRightOutlined,
  CalendarOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Navigate, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth";
import { errorMessage } from "../api";
import { BackLink, LoadingState } from "../components";
export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm<{ username: string; password: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const state = location.state as { from?: string; notice?: string } | null;
  const destination =
    state?.from?.startsWith("/") &&
    !state.from.startsWith("//") &&
    state.from !== "/login"
      ? state.from
      : "/activities";

  if (auth.loading)
    return (
      <div className="page-container">
        <LoadingState />
      </div>
    );
  if (auth.user) return <Navigate to={destination} replace />;

  async function submit(values: { username: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      await auth.login(values.username.trim(), values.password);
      if (!mounted.current) return;
      navigate(destination, { replace: true });
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="page-container login-page">
      <BackLink />
      <div className="login-layout">
        <section className="login-story">
          <span className="eyebrow">GATHER · 活动报名</span>
          <h1>
            登录集会，
            <br />
            参与下一场活动。
          </h1>
          <p>
            参与者可以报名、取消和查看记录。
            <br />
            组织者还可以发布新的活动。
          </p>
          <div className="login-art" aria-hidden="true">
            <div />
            <div />
            <div />
            <span>g.</span>
          </div>
          <span className="login-story-bottom">
            集会 Gather · 活动时间均为北京时间
          </span>
        </section>
        <section className="login-form-panel">
          <span className="eyebrow muted">WELCOME TO GATHER</span>
          <h2>欢迎来到集会</h2>
          <p className="form-intro">登录账号，开启你的下一场活动。</p>
          {(state?.notice || auth.error) && (
            <Alert
              className="form-alert"
              type="warning"
              showIcon
              title={state?.notice ?? auth.error}
            />
          )}
          {error && (
            <Alert className="form-alert" type="error" showIcon title={error} />
          )}
          <Form
            form={form}
            layout="vertical"
            onFinish={submit}
            requiredMark={false}
            size="large"
          >
            <Form.Item
              name="username"
              label="账号"
              rules={[
                { required: true, whitespace: true, message: "请输入账号" },
              ]}
            >
              <Input
                autoComplete="username"
                prefix={<UserOutlined aria-hidden="true" />}
                placeholder="输入你的账号"
                maxLength={64}
              />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                autoComplete="current-password"
                placeholder="输入密码"
                maxLength={128}
              />
            </Form.Item>
            <Button type="primary" block htmlType="submit" loading={busy}>
              登录 <ArrowRightOutlined aria-hidden="true" />
            </Button>
          </Form>
          <div className="demo-accounts">
            <div className="demo-heading">
              <span>先体验，再探索</span>
              <small>选择演示账号，自动填入表单</small>
            </div>
            <div className="demo-buttons">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  form.setFieldsValue({
                    username: "demo",
                    password: "Demo123!",
                  });
                  setError(null);
                }}
              >
                <UserOutlined aria-hidden="true" />
                <strong>活动参与者</strong>
                <span>报名 · 查看记录</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  form.setFieldsValue({
                    username: "admin",
                    password: "Admin123!",
                  });
                  setError(null);
                }}
              >
                <CalendarOutlined aria-hidden="true" />
                <strong>活动组织者</strong>
                <span>发布 · 参与活动</span>
              </button>
            </div>
            <p>演示账号：demo / Demo123! · admin / Admin123!</p>
          </div>
        </section>
      </div>
    </div>
  );
}
