import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space } from "antd";
import { useAuth } from "../auth";
import { errorMessage } from "../api";
import { validateAvatar } from "../accountAvatar";
import { AccountAvatar } from "../PersonalAvatar";
import "./avatar.css";

export function AvatarEditor() {
  const auth = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);
  const previewLease = useRef<string | null>(null);
  const account = auth.captureAccountRequest();
  const accountKey = `${account?.userId}:${account?.generation}`;

  function clearSelection() {
    setFile(null);
    setPreview(null);
    if (previewLease.current) URL.revokeObjectURL(previewLease.current);
    previewLease.current = null;
    if (input.current) input.current.value = "";
  }

  useLayoutEffect(() => {
    mounted.current = true;
    const reset = () => {
      submission.current?.abort();
      submission.current = null;
      clearSelection();
      setBusy(false); setError(null); setNotice(null);
    };
    const unsubscribe = auth.subscribeAuthentication(reset);
    reset();
    return () => {
      mounted.current = false;
      unsubscribe();
      submission.current?.abort();
      if (previewLease.current) URL.revokeObjectURL(previewLease.current);
      previewLease.current = null;
    };
  }, [accountKey, auth.subscribeAuthentication]);

  async function save(remove = false) {
    if (submission.current || !remove && !file) return;
    const ticket = auth.captureAccountRequest();
    if (!ticket) return;
    const controller = new AbortController();
    submission.current = controller;
    const current = () => mounted.current && !controller.signal.aborted &&
      submission.current === controller && auth.isCurrentAccountRequest(ticket);
    setBusy(true); setError(null); setNotice(null);
    try {
      await auth.updateAvatar(remove ? null : file!, controller.signal);
      if (!current()) return;
      clearSelection();
      setNotice(remove ? "头像已移除" : "头像已更新");
    } catch (err) {
      if (current() && !(err instanceof DOMException && err.name === "AbortError")) setError(errorMessage(err));
    } finally {
      if (current()) {
        submission.current = null;
        setBusy(false);
      }
    }
  }

  return <Card title="我的头像" className="profile-card avatar-editor" data-testid="avatar-editor">
    <div className="avatar-preview" data-testid="avatar-preview">
      {preview ? <img key={preview} src={preview} alt="待上传头像" onError={() => {
        if (previewLease.current !== preview || !mounted.current || !account || !auth.isCurrentAccountRequest(account)) return;
        clearSelection(); setError("无法预览这张图片，请重新选择 PNG 或 JPEG 图片。");
      }} /> : <AccountAvatar size={256} />}
    </div>
    <p className="profile-form-intro">支持 PNG、JPEG，文件不超过 2 MB，宽高不超过 4096 像素、总像素不超过 1600 万。保存后以 256 × 256 显示。</p>
    <label htmlFor="avatar-file">选择头像</label>
    <input ref={input} id="avatar-file" type="file" className="avatar-file" accept="image/png,image/jpeg,.png,.jpg,.jpeg"
      disabled={busy} onChange={event => {
        const selected = event.target.files?.[0];
        clearSelection(); setNotice(null);
        if (!selected) { setError(null); return; }
        const invalid = validateAvatar(selected);
        setError(invalid);
        if (invalid) return;
        const url = URL.createObjectURL(selected);
        previewLease.current = url;
        setFile(selected); setPreview(url);
      }} />
    {error && <Alert type="error" showIcon title={error} />}
    {notice && <p role="status">{notice}</p>}
    <Space wrap className="avatar-actions">
      <Button type="primary" aria-label="上传头像" loading={busy} disabled={busy || !file} onClick={() => void save()}>
        {auth.user?.avatarUrl ? "更换头像" : "上传头像"}
      </Button>
      <Button aria-label="取消头像选择" disabled={busy || !file} onClick={() => { clearSelection(); setError(null); }}>取消选择</Button>
      <Button danger aria-label="移除头像" disabled={busy || !auth.user?.avatarUrl} onClick={() => void save(true)}>移除头像</Button>
    </Space>
  </Card>;
}
