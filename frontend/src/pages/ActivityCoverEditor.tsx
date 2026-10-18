import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space } from "antd";
import { api } from "../api";
import { ActivityCover } from "../ActivityCoverImage";
import { validateActivityCover } from "../activityCover";
import { canManageActivity } from "../activityLifecycle";
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
    if (!enabled || !remove && !file) return;
    setNotice(null); setError(null);
    await mutation.run(signal => remove ? api.removeActivityCover(activity.id, signal) :
      api.uploadActivityCover(activity.id, file!, signal), updated => {
      // Keep unsaved text fields intact: this mutation owns only the cover preview.
      setCoverUrl(updated.coverUrl); clearSelection();
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
        setNotice(null); mutation.clearError();
        const selected = event.target.files?.[0];
        if (!selected) { clearSelection(); return; }
        const invalid = validateActivityCover(selected);
        setError(invalid); setFile(invalid ? null : selected);
        if (invalid) event.target.value = "";
      }} />
    {error && <Alert type="error" showIcon title={error} />}
    {notice && <p role="status">{notice}</p>}
    {!canManageActivity(activity) && <p>活动已开始或已取消，不能修改封面。</p>}
    <Space wrap className="cover-actions">
      <Button type="primary" aria-label="上传封面" disabled={!enabled || !file} loading={mutation.busy}
        onClick={() => void save()}>上传封面</Button>
      <Button disabled={!enabled || !file} onClick={clearSelection}>取消选择</Button>
      <Button danger disabled={!enabled || !coverUrl} onClick={() => void save(true)}>移除封面</Button>
    </Space>
  </Card>;
}
