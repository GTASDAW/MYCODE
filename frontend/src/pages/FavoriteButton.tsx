import { useEffect, useRef, useState } from "react";
import { Alert, Button, Space } from "antd";
import { StarFilled, StarOutlined } from "@ant-design/icons";
import { Link } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import { useFavoriteRead } from "./useFavoriteRead";

export function FavoriteButton({activityId, detailPath}: {activityId: number; detailPath: string}) {
  const auth = useAuth();
  const account = auth.captureAccountRequest();
  if (!account) return <Link to="/login" state={{from: detailPath}}><Button icon={<StarOutlined aria-hidden="true" />}>登录后收藏</Button></Link>;
  return <AccountFavoriteButton key={`${activityId}:${account.userId}:${account.generation}`} activityId={activityId} />;
}

function AccountFavoriteButton({activityId}: {activityId: number}) {
  const auth = useAuth();
  const resource = useFavoriteRead(signal => api.favorite(activityId, signal), String(activityId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false); setError(null);
    return () => { request.current?.abort(); request.current = null; };
  }, [resource.key]);
  async function change() {
    if (!resource.data || request.current || !resource.current()) return;
    const controller = new AbortController(); request.current = controller;
    const current = () => resource.current() && !controller.signal.aborted && request.current === controller;
    setBusy(true); setError(null);
    try {
      const updated = await api.setFavorite(activityId, !resource.data.favorited, controller.signal);
      if (current()) resource.setData(updated);
    } catch (caught) {
      if (!current()) return;
      if (caught instanceof ApiError && caught.status === 401) auth.expire();
      else setError(errorMessage(caught));
    } finally {
      if (current()) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }
  if (resource.loading) return <Button loading disabled>读取收藏状态</Button>;
  if (resource.error) return <Space><span role="status">收藏状态暂时不可用</span><Button onClick={resource.retry}>重试收藏状态</Button></Space>;
  return <Space wrap>
    <Button onClick={change} loading={busy} disabled={!resource.data}
      aria-pressed={resource.data?.favorited ?? false}
      icon={resource.data?.favorited ? <StarFilled aria-hidden="true" /> : <StarOutlined aria-hidden="true" />}>
      {resource.data?.favorited ? "取消收藏" : "收藏活动"}
    </Button>
    {error && <Alert type="error" title={error} showIcon />}
  </Space>;
}
