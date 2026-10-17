import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Space } from "antd";
import { CalendarOutlined } from "@ant-design/icons";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { buildActivityCalendar, calendarContentType } from "../activityCalendar";
import { downloadFile } from "../fileDownload";

export function CalendarDownloadButton({ activityId, cancelled, detailPath, refresh }: {
  activityId: number; cancelled: boolean; detailPath: string; refresh: () => void;
}) {
  const auth = useAuth();
  const generation = auth.captureAuthenticationRequest();
  const scope = `${activityId}:${detailPath}:${generation}:${cancelled}`;
  const live = useRef<string | null>(scope);
  live.current = scope;
  const submission = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellationDetected, setCancellationDetected] = useState(false);
  useLayoutEffect(() => {
    live.current = scope;
    setBusy(false); setError(null); setCancellationDetected(false);
    return () => {
      if (live.current === scope) live.current = null;
      submission.current?.abort(); submission.current = null;
    };
  }, [scope]);

  async function download() {
    if (submission.current || cancelled || cancellationDetected) return;
    const controller = new AbortController(); submission.current = controller;
    const current = () => live.current === scope && submission.current === controller &&
      !controller.signal.aborted && auth.isCurrentAuthenticationRequest(generation);
    setBusy(true); setError(null);
    try {
      const latest = await api.activity(String(activityId), controller.signal);
      if (!current()) return;
      if (latest.id !== activityId) throw new Error("活动信息不正确，请刷新详情后重试。");
      if (latest.cancelled) {
        setCancellationDetected(true);
        throw new Error("活动已取消，无法导出日历。请刷新详情确认。");
      }
      const calendar = buildActivityCalendar(latest, window.location.origin, new Date());
      // This read belongs to the export only; never replace registration/page state.
      if (current()) downloadFile(new Blob([calendar], { type: calendarContentType }), `activity-${activityId}.ics`, current);
    } catch (caught) {
      if (current()) setError(errorMessage(caught));
    } finally {
      const stillCurrent = current();
      if (submission.current === controller) submission.current = null;
      if (stillCurrent) setBusy(false);
    }
  }
  return <Space orientation="vertical" size="small">
    <Button aria-label="下载日历" icon={<CalendarOutlined aria-hidden="true" />} loading={busy} disabled={busy || cancelled || cancellationDetected}
      onClick={download}>下载日历</Button>
    {(cancelled || cancellationDetected) && <span className="metadata">活动已取消，无法导出日历。</span>}
    {error && <Alert type="error" showIcon title={error}
      action={cancellationDetected ? <Button size="small" onClick={refresh}>刷新详情</Button> : undefined} />}
  </Space>;
}
