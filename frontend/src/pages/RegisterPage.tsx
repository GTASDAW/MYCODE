import { useEffect, useRef, useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { ArrowRightOutlined, UserOutlined } from "@ant-design/icons";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth";
import { api, errorMessage } from "../api";
import { useAuthRateLimit } from "../useAuthRateLimit";
import { displayNameError, passwordError, usernameError } from "../accountValidation";
import { BackLink, LoadingState } from "../components";
import type { NewUser } from "../types";
import { safeReturnPath } from "./authNavigation";

interface RegisterValues extends NewUser {
  confirmPassword: string;
}

export function RegisterPage() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);
  const { remaining, acceptRateLimit } = useAuthRateLimit(auth.isCurrentAuthenticationRequest);
  const state = location.state as { from?: string } | null;
  const destination = safeReturnPath(state?.from);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submission.current?.abort();
    };
  }, []);

  if (auth.loading)
    return <div className="page-container"><LoadingState /></div>;
  if (auth.user) return <Navigate to="/profile" replace />;

  async function submit(values: RegisterValues) {
    if (submission.current || remaining > 0) return;
    const controller = new AbortController();
    submission.current = controller;
    const generation = auth.captureAuthenticationRequest();
    const isCurrent = () => mounted.current && !controller.signal.aborted &&
      submission.current === controller && auth.isCurrentAuthenticationRequest(generation);
    setBusy(true);
    setError(null);
    try {
      const registered = await api.registerUser({
        username: values.username.trim().toLowerCase(),
        password: values.password,
        displayName: values.displayName.trim(),
      }, controller.signal);
      if (!isCurrent()) return;
      navigate("/login", {
        replace: true,
        state: {
          from: destination,
          username: registered.username,
          notice: "注册成功，请登录你的账号。",
          registered: true,
        },
      });
    } catch (err) {
      if (isCurrent() && !(err instanceof DOMException && err.name === "AbortError")) {
        if (!acceptRateLimit(err, generation)) setError(errorMessage(err));
      }
    } finally {
      if (submission.current === controller) {
        submission.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  return (
    <div className="page-container login-page register-page">
      <BackLink />
      <div className="login-layout">
        <section className="login-story">
          <span className="eyebrow">GATHER · 活动报名</span>
          <h1>注册集会</h1>
          <p>创建你的账号，发现活动、报名参与，<br />留下每一次相聚的记录。</p>
          <div className="login-art" aria-hidden="true"><span>g.</span></div>
          <span className="login-story-bottom">集会 Gather · 活动时间均为北京时间</span>
        </section>
        <section className="login-form-panel">
          <span className="eyebrow muted">JOIN GATHER</span>
          <h2>创建你的账号</h2>
          <p className="form-intro">注册后使用账号和密码登录。</p>
          {error && <Alert className="form-alert" type="error" showIcon title={error} />}
          {remaining > 0 && (
            <Alert className="form-alert" type="warning" showIcon
              title={`请求过于频繁，请等待 ${remaining} 秒后再试。`}
              description="等待期间可以修改输入，到期后请手动提交。" />
          )}
          <Form<RegisterValues>
            layout="vertical"
            onFinish={submit}
            requiredMark={false}
            size="large"
            disabled={busy}
          >
            <Form.Item name="username" label="账号" extra="3–32 位，以英文字母开头，可使用数字和下划线。" rules={[
              { validator: (_, value: string = "") => {
                const message = usernameError(value);
                return message ? Promise.reject(new Error(message)) : Promise.resolve();
              } },
            ]}>
              <Input autoComplete="username" prefix={<UserOutlined aria-hidden="true" />} placeholder="设置登录账号" maxLength={64} />
            </Form.Item>
            <Form.Item name="displayName" label="昵称" extra="1–40 位，可以之后在个人中心修改。" rules={[
              { validator: (_, value: string = "") => {
                const message = displayNameError(value);
                return message ? Promise.reject(new Error(message)) : Promise.resolve();
              } },
            ]}>
              <Input autoComplete="nickname" placeholder="大家如何称呼你" maxLength={80} />
            </Form.Item>
            <Form.Item name="password" label="密码" extra="8–64 位，包含英文字母和数字。" rules={[
              { validator: (_, value: string = "") => {
                const message = passwordError(value);
                return message ? Promise.reject(new Error(message)) : Promise.resolve();
              } },
            ]}>
              <Input.Password autoComplete="new-password" placeholder="设置密码" maxLength={128} />
            </Form.Item>
            <Form.Item name="confirmPassword" label="确认密码" dependencies={["password"]} rules={[
              { required: true, message: "请再次输入密码" },
              ({ getFieldValue }) => ({ validator: (_, value: string) =>
                value && value !== getFieldValue("password")
                  ? Promise.reject(new Error("两次输入的密码不一致"))
                  : Promise.resolve(),
              }),
            ]}>
              <Input.Password autoComplete="new-password" placeholder="再次输入密码" maxLength={128} />
            </Form.Item>
            <Button type="primary" block htmlType="submit" loading={busy} disabled={remaining > 0} aria-label="注册账号" aria-busy={busy}>{remaining > 0 ? `等待 ${remaining} 秒` : "注册账号"} <ArrowRightOutlined aria-hidden="true" /></Button>
          </Form>
          <p className="account-switch">已有账号？<Link to="/login" state={{ from: destination }}>去登录</Link></p>
        </section>
      </div>
    </div>
  );
}
