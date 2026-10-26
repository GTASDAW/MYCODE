import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Input, Space } from "antd";
import { api } from "../api";
import { ActivityCover } from "../ActivityCoverImage";
import { validateActivityCover } from "../activityCover";
import { canManageActivity } from "../activityLifecycle";
import { useRemoteImageImport } from "../useRemoteImageImport";
import type { Activity } from "../types";
import type { useActivityMutation } from "./useActivityMutation";

export function ActivityCoverEditor({ activity, mutation }: {
  activity: Activity; mutation: ReturnType<typeof useActivityMutation>;
}) {
  const [coverUrl, setCoverUrl] = useState(activity.coverUrl);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const enabled = canManageActivity(activity) && !mutation.busy;
  const imported = useRemoteImageImport(`cover:${activity.id}`, enabled);
  useLayoutEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function clearSelection() {
    setFile(null); setError(null);
    if (input.current) input.current.value = "";
  }
  async function save(remove = false) {
    if (!enabled || imported.isPending() || !remove && !file) return;
    setNotice(null); setError(null);
    await mutation.run(signal => remove ? api.removeActivityCover(activity.id, signal) :
      api.uploadActivityCover(activity.id, file!, signal), updated => {
      // Keep unsaved text fields intact: this mutation owns only the cover preview.
      setCoverUrl(updated.coverUrl); imported.cancel(true); clearSelection();
      setNotice(remove ? "封面已移除" : "封面已保存");
    });
  }
  return <Card title="活动封面" className="create-form-panel cover-editor">
    {preview ? <div className="activity-cover"><img src={preview} alt="待上传活动封面" /></div> :
      <ActivityCover id={activity.id} url={coverUrl} title={activity.title} />}
    <p className="metadata">支持 PNG、JPEG，文件不超过 2 MB，宽高不超过 4096 像素。选择后点击上传，封面单独保存。</p>
    <label htmlFor={`cover-file-${activity.id}`}>选择活动封面</label>
    <input ref={input} id={`cover-file-${activity.id}`} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg"
      disabled={!enabled} className="cover-file" onChange={event => {
        imported.cancel(true);
        setNotice(null); mutation.clearError();
        const selected = event.target.files?.[0];
        if (!selected) { clearSelection(); return; }
        const invalid = validateActivityCover(selected);
        setError(invalid); setFile(invalid ? null : selected);
        if (invalid) event.target.value = "";
      }} />
    <div className="remote-image-import">
      <label htmlFor={`cover-image-url-${activity.id}`}>封面图片链接</label>
      <div className="remote-image-controls">
        <Input id={`cover-image-url-${activity.id}`} aria-label="封面图片链接" type="url" autoComplete="off" spellCheck={false}
          value={imported.url} disabled={!enabled} placeholder="粘贴公开 HTTPS 图片链接"
          onChange={event => { imported.setUrl(event.target.value); setNotice(null); setError(null); mutation.clearError(); }} />
        <Button aria-label="从链接导入封面" loading={imported.pending} disabled={!enabled || imported.pending || !imported.url.trim()}
          onClick={() => {
            setError(null); setNotice(null); mutation.clearError();
            void imported.importFile(validateActivityCover, selected => {
              if (input.current) input.current.value = "";
              setFile(selected); setNotice("图片已导入，请点击上传保存。");
            });
          }}>{imported.pending ? "正在导入封面" : "从链接导入封面"}</Button>
      </div>
      <p className="metadata">仅支持公开 HTTPS 的 PNG、JPEG 图片；点击导入后才访问链接，无法直接读取时请先下载到本地。</p>
    </div>
    {error && <Alert type="error" showIcon title={error} />}
    {imported.error && <Alert type="error" showIcon title={imported.error} />}
    {notice && <p role="status">{notice}</p>}
    {!canManageActivity(activity) && <p>活动已开始或已取消，不能修改封面。</p>}
    <Space wrap className="cover-actions">
      <Button type="primary" aria-label="上传封面" disabled={!enabled || imported.pending || !file} loading={mutation.busy}
        onClick={() => void save()}>上传封面</Button>
      <Button aria-label="取消封面选择" disabled={!enabled || !file && !imported.url && !imported.pending}
        onClick={() => { imported.cancel(true); clearSelection(); setNotice(null); }}>取消选择</Button>
      <Button danger disabled={!enabled || imported.pending || !coverUrl} onClick={() => void save(true)}>移除封面</Button>
    </Space>
    <p className="metadata">先选择文件或导入图片，再点击上传保存。{!file && !imported.pending && "尚未选择待上传图片。"}</p>
  </Card>;
}
