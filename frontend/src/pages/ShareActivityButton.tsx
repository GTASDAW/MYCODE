import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { App as AntApp, Button, Input, Modal } from "antd";
import { LinkOutlined } from "@ant-design/icons";
import { useLocation } from "react-router";
import { useAuth } from "../auth";
import { ActivityShareRequests, buildActivityShareUrl } from "../activityShare";

interface ShareState { scope: string; busy: boolean; manualUrl: string | null }

export function ShareActivityButton({ activityId }: { activityId: number }) {
  const { pathname, search, hash } = useLocation();
  const auth = useAuth();
  const generation = useSyncExternalStore(auth.subscribeAuthentication,
    auth.captureAuthenticationRequest, auth.captureAuthenticationRequest);
  const scope = JSON.stringify([activityId, pathname, search, hash, generation]);
  const live = useRef<string | null>(scope);
  live.current = scope;
  const requests = useRef(new ActivityShareRequests());
  const [state, setState] = useState<ShareState>({ scope, busy: false, manualUrl: null });
  const { message } = AntApp.useApp();
  const feedbackKey = useId();
  const visible = state.scope === scope;
  const busy = visible && state.busy;
  const manualUrl = visible ? state.manualUrl : null;
  const current = () => live.current === scope && auth.isCurrentAuthenticationRequest(generation);

  useLayoutEffect(() => {
    live.current = scope;
    setState({ scope, busy: false, manualUrl: null });
    return () => {
      if (live.current === scope) live.current = null;
      requests.current.invalidate();
      message.destroy(feedbackKey);
    };
  }, [scope, message, feedbackKey]);

  function copy() {
    if (!current()) return;
    let url: string;
    try { url = buildActivityShareUrl(activityId, window.location.origin); }
    catch {
      if (current()) void message.error({ key: feedbackKey, content: "活动链接不正确，请刷新详情后重试。" });
      return;
    }
    void requests.current.copy({
      url, isCurrent: current,
      write: value => {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        return navigator.clipboard.writeText(value);
      },
      onStart: () => setState({ scope, busy: true, manualUrl: null }),
      onSuccess: () => { void message.success({ key: feedbackKey, content: "活动链接已复制" }); },
      onFallback: () => setState({ scope, busy: true, manualUrl: url }),
      onFinish: () => setState(previous => previous.scope === scope ? { ...previous, busy: false } : previous),
    });
  }

  function closeManualCopy() {
    if (current()) setState({ scope, busy: false, manualUrl: null });
  }

  return <>
    <Button aria-label="复制活动链接" icon={<LinkOutlined aria-hidden="true" />}
      loading={busy} disabled={busy} onClick={copy}>复制活动链接</Button>
    <Modal title="复制活动链接" open={manualUrl !== null} destroyOnHidden onCancel={closeManualCopy}
      footer={<Button aria-label="关闭分享链接" onClick={closeManualCopy}>关闭</Button>}>
      <p>自动复制未完成，请手动复制下方链接。</p>
      <Input aria-label="活动公开链接" value={manualUrl ?? ""} readOnly onFocus={event => event.currentTarget.select()} />
    </Modal>
  </>;
}
