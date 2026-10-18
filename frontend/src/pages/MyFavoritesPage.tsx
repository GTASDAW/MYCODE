import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Pagination, Space } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { Link, useLocation, useNavigate } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import { ActivityCard, EmptyState, ErrorState, LoadingState, PageHeading } from "../components";
import { formatDate, formatTime } from "../date";
import { favoriteListPath, parseFavoriteQuery, serializeFavoriteQuery } from "../favoriteQuery";
import { myRegistrationDetailsPath } from "../activityDetailNavigation";
import { useFavoriteRead } from "./useFavoriteRead";
import { useActivityClock } from "../useActivityClock";

export function MyFavoritesPage() {
  const auth = useAuth();
  const {search} = useLocation();
  const navigate = useNavigate();
  const query = parseFavoriteQuery(search);
  const canonical = serializeFavoriteQuery(query);
  const resource = useFavoriteRead(signal => api.favorites(query, signal), canonical);
  useActivityClock(resource.data?.items.map(item => item.activity) ?? []);
  const [busy, setBusy] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const submission = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(null); setActionError(null);
    return () => { submission.current?.abort(); submission.current = null; };
  }, [resource.key]);
  useEffect(() => {
    if (search !== canonical) navigate(favoriteListPath(query), {replace:true});
  }, [search, canonical, navigate]);
  const total = resource.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const correcting = !resource.loading && !resource.error && !!resource.data && query.page > lastPage;
  useEffect(() => {
    if (correcting && resource.current()) navigate(favoriteListPath({...query,page:lastPage}), {replace:true});
  }, [correcting, lastPage, resource.key, navigate]);

  async function remove(id: number) {
    if (submission.current || !resource.current()) return;
    const controller = new AbortController(); submission.current = controller;
    const current = () => resource.current() && !controller.signal.aborted && submission.current === controller;
    setBusy(id); setActionError(null);
    try {
      await api.setFavorite(id, false, controller.signal);
      if (!current()) return;
      setBusy(null); resource.retry();
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) auth.expire();
      else setActionError(errorMessage(error));
    } finally {
      if (current()) setBusy(null);
      if (submission.current === controller) submission.current = null;
    }
  }
  return <div className="page-container">
    <PageHeading title="我的收藏" section="我的账号" description="收藏感兴趣的活动，稍后查看或报名。已开始、已取消的活动仍会保留。"
      extra={<Button icon={<ReloadOutlined aria-hidden="true" />} loading={resource.loading} onClick={resource.retry}>刷新收藏</Button>} />
    {actionError && <Alert className="discovery-notice" type="error" showIcon title={actionError} />}
    {resource.loading || correcting ? <LoadingState /> : resource.error ? <ErrorState error={resource.error} retry={resource.retry} />
      : !resource.data?.items.length ? <EmptyState title="还没有收藏活动" description="打开活动详情，将感兴趣的活动加入收藏。"
        action={<Link to="/activities"><Button type="primary">去发现活动</Button></Link>} />
      : <div className="activity-grid" aria-label="我的收藏记录">{resource.data.items.map(item => <div key={item.activity.id} data-testid={`favorite-${item.activity.id}`}>
        <ActivityCard activity={item.activity} detailsTo={myRegistrationDetailsPath(item.activity.id, favoriteListPath(query))} />
        <Card size="small"><Space wrap>
          <span className="metadata">收藏于（北京时间）{formatDate(item.favoritedAt)} {formatTime(item.favoritedAt)}</span>
          <Button disabled={busy !== null} loading={busy === item.activity.id} onClick={() => remove(item.activity.id)}>取消收藏</Button>
        </Space></Card>
      </div>)}</div>}
    {!resource.loading && !resource.error && !correcting && total > 0 && <Card className="myregistrations-pagination">
      <Pagination aria-label="收藏分页" current={query.page} pageSize={query.pageSize} total={total} responsive showLessItems
        showSizeChanger={{"aria-label":"每页收藏数量"}} pageSizeOptions={[...new Set([10,20,50,query.pageSize])].sort((a,b)=>a-b)}
        showTotal={count => `共 ${count} 条收藏`}
        onChange={(page,pageSize) => navigate(favoriteListPath({page:pageSize === query.pageSize ? page : 1,pageSize}))} />
    </Card>}
  </div>;
}
