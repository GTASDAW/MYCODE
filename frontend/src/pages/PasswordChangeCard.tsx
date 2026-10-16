import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Form, Input } from "antd";
import { useNavigate } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { PasswordSignOutResult } from "../auth";
import { passwordError } from "../accountValidation";
import { readAccountResource } from "../authRequestGuard";
import { currentPasswordError, passwordChangeUnconfirmed, passwordConfirmationError, passwordLoginState, passwordUnconfirmedNotice } from "../passwordChange";
import { useAuthRateLimit } from "../useAuthRateLimit";
import "./passwordChange.css";

interface PasswordValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export function PasswordChangeCard() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [form] = Form.useForm<PasswordValues>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);
  const ownedGeneration = useRef<number | null>(null);
  const account = auth.captureAccountRequest();
  const accountKey = `${account?.userId}:${account?.generation}`;
  const previousAccount = useRef(accountKey);
  const { remaining, acceptRateLimit } = useAuthRateLimit(auth.isCurrentAuthenticationRequest);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submission.current?.abort();
      form.resetFields();
    };
  }, [form]);
  useLayoutEffect(() => {
    if (previousAccount.current === accountKey) return;
    previousAccount.current = accountKey;
    // The confirmed change owns a short transition while refreshing anonymous
    // CSRF. Any different authentication must cancel and clear these secrets.
    if (ownedGeneration.current !== null && account?.generation === ownedGeneration.current) return;
    submission.current?.abort();
    submission.current = null;
    ownedGeneration.current = null;
    form.resetFields();
    setBusy(false);
    setError(null);
    setUnconfirmed(false);
  }, [accountKey, account?.generation, form]);

  const finish = (controller: AbortController, confirmed: boolean) => (result: PasswordSignOutResult) => {
    if (!mounted.current || controller.signal.aborted || submission.current !== controller ||
      !auth.isCurrentAuthenticationRequest(result.generation)) return;
    form.resetFields();
    navigate("/login", { replace: true, state: passwordLoginState(result, confirmed) });
  };

  async function submit(values: PasswordValues) {
    if (submission.current || remaining > 0 || unconfirmed) return;
    const ticket = auth.captureAccountRequest();
    if (!ticket) return;
    const controller = new AbortController();
    submission.current = controller;
    setBusy(true);
    setError(null);
    const current = () => mounted.current && !controller.signal.aborted && submission.current === controller && auth.isCurrentAccountRequest(ticket);
    try {
      await readAccountResource(signal => api.changePassword(values.currentPassword, values.newPassword, signal),
        controller.signal, current, () => {});
      if (!current()) return;
      form.resetFields();
      const completion = auth.completePasswordChange(ticket, controller.signal, finish(controller, true));
      ownedGeneration.current = auth.captureAuthenticationRequest();
      await completion;
    } catch (err) {
      if (!current() || err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof ApiError && err.status === 401) {
        form.resetFields();
        auth.expire();
        navigate("/login", { replace: true, state: { from: "/profile", notice: "登录已失效，请重新登录后继续。" } });
      } else if (passwordChangeUnconfirmed(err)) {
        setUnconfirmed(true);
        setError(passwordUnconfirmedNotice);
      } else if (!acceptRateLimit(err, ticket.generation)) setError(errorMessage(err));
    } finally {
      if (submission.current === controller) {
        submission.current = null;
        if (mounted.current && !controller.signal.aborted &&
          (auth.isCurrentAccountRequest(ticket) || ownedGeneration.current !== null && auth.isCurrentAuthenticationRequest(ownedGeneration.current))) setBusy(false);
      }
    }
  }

  async function confirmByLogin() {
    if (submission.current) return;
    const ticket = auth.captureAccountRequest();
    if (!ticket) return;
    const controller = new AbortController();
    submission.current = controller;
    setBusy(true);
    setError(passwordUnconfirmedNotice);
    try {
      await auth.signOutToConfirmPassword(ticket, controller.signal, finish(controller, false));
    } catch (err) {
      if (!mounted.current || controller.signal.aborted || submission.current !== controller || !auth.isCurrentAccountRequest(ticket)) return;
      setError(`${passwordUnconfirmedNotice} 暂时无法退出，请重试。${errorMessage(err)}`);
    } finally {
      if (submission.current === controller) {
        submission.current = null;
        if (mounted.current && !controller.signal.aborted && auth.isCurrentAccountRequest(ticket)) setBusy(false);
      }
    }
  }

  return <Card title="修改密码" className="profile-card password-change-card" data-testid="password-change-card">
    <p className="profile-form-intro">修改后所有登录均需重新登录</p>
    {error && <Alert className="form-alert" type={unconfirmed ? "warning" : "error"} showIcon title={error} />}
    {remaining > 0 && <Alert className="form-alert" type="warning" showIcon title={`请求过于频繁，请等待 ${remaining} 秒后再试。`}
      description="等待期间可以修改输入，到期后请手动提交。" />}
    {unconfirmed && <p className="profile-form-intro">请先重新登录确认当前密码，再决定后续操作。</p>}
    <Form<PasswordValues> form={form} layout="vertical" onFinish={submit} requiredMark={false} disabled={busy || unconfirmed} clearOnDestroy>
      <Form.Item name="currentPassword" label="当前密码" rules={[{ validator: (_, value: string = "") => {
        const message = currentPasswordError(value);
        return message ? Promise.reject(new Error(message)) : Promise.resolve();
      } }]}>
        <Input.Password autoComplete="current-password" placeholder="输入当前密码" maxLength={128} />
      </Form.Item>
      <Form.Item name="newPassword" label="新密码" extra="8–64 位，包含英文字母和数字，UTF-8 编码不超过 72 字节。" rules={[{ validator: (_, value: string = "") => {
        const message = passwordError(value);
        return message ? Promise.reject(new Error(message)) : Promise.resolve();
      } }]}>
        <Input.Password autoComplete="new-password" placeholder="设置新密码" maxLength={128} />
      </Form.Item>
      <Form.Item name="confirmPassword" label="确认新密码" dependencies={["newPassword"]} rules={[
        ({ getFieldValue }) => ({ validator: (_, value: string = "") => {
          const message = passwordConfirmationError(getFieldValue("newPassword") ?? "", value);
          return message ? Promise.reject(new Error(message)) : Promise.resolve();
        } }),
      ]}>
        <Input.Password autoComplete="new-password" placeholder="再次输入新密码" maxLength={128} />
      </Form.Item>
      <Button type="primary" htmlType="submit" aria-label="修改密码" aria-busy={busy} loading={busy} disabled={remaining > 0 || unconfirmed}>
        {remaining > 0 ? `等待 ${remaining} 秒` : "修改密码"}
      </Button>
    </Form>
    {unconfirmed && <Button className="password-confirm-login" type="primary" aria-label="重新登录确认" loading={busy} onClick={() => void confirmByLogin()}>重新登录确认</Button>}
  </Card>;
}
