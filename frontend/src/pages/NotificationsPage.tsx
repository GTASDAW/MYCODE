import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Card, Pagination, Select, Tag } from "antd";
import { CheckOutlined, ReloadOutlined } from "@ant-design/icons";
import { Link, useLocation, useNavigate } from "react-router";
import { errorMessage } from "../api";
import { useAuth } from "../auth";
import { EmptyState, ErrorState, LoadingState, PageHeading } from "../components";
import { formatDate, formatTime } from "../date";
import { useNotifications } from "../notifications";
import { parseNotificationQuery, serializeNotificationQuery } from "../notificationQuery";
import type { NotificationFilter, NotificationQuery } from "../types";
import { useResource } from "../useResource";

export function NotificationsPage() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const auth = useAuth();
  const { accountKey, loadNotifications, markRead } = useNotifications();
  const query = useMemo(() => parseNotificationQuery(search), [search]);
  const querySearch = serializeNotificationQuery(query);
  const resource = useResource((signal) => loadNotifications(query, signal),
    [accountKey, query.status, query.page, query.pageSize, loadNotifications]);
  const { message } = AntApp.useApp();
  const [readingId, setReadingId] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);
  const pageKey = `${accountKey}:${querySearch}`;
  const currentPage = useRef(pageKey);
  currentPage.current = pageKey;

  useEffect(() => {
    if (search !== querySearch) navigate(`/notifications${querySearch}`, { replace: true });
  }, [search, querySearch, navigate]);

  const lastPage = resource.data ? Math.max(1, Math.ceil(resource.data.total / query.pageSize)) : query.page;
  const correctingPage = !resource.loading && !resource.error && !!resource.data && query.page > lastPage;
  useEffect(() => {
    if (correctingPage) navigate(`/notifications${serializeNotificationQuery({ ...query, page: lastPage })}`, { replace: true });
  }, [correctingPage, lastPage, query.page, query.pageSize, query.status, navigate]);

  useEffect(() => {
    mounted.current = true;
    setReadingId(null);
    setMutationError(null);
    return () => {
      mounted.current = false;
      submission.current?.abort();
      submission.current = null;
    };
  }, [pageKey]);

  function changeQuery(next: NotificationQuery) {
    setMutationError(null);
    if (serializeNotificationQuery(next) === querySearch) resource.retry();
    else navigate(`/notifications${serializeNotificationQuery(next)}`);
  }

  async function read(id: number) {
    if (submission.current) return;
    const account = auth.captureAccountRequest();
    if (!account) return;
    const startedPage = pageKey;
    const controller = new AbortController();
    submission.current = controller;
    setReadingId(id);
    setMutationError(null);
    const current = () => mounted.current && !controller.signal.aborted &&
      currentPage.current === startedPage && auth.isCurrentAccountRequest(account);
    try {
      await markRead(id, controller.signal);
      if (!current()) return;
      message.success("已标记为已读");
      resource.retry();
    } catch (err) {
      if (!current()) return;
      setMutationError(errorMessage(err));
      // Refresh from the database even if a write response was lost.
      resource.retry();
    } finally {
      if (submission.current === controller) {
        submission.current = null;
        if (current()) setReadingId(null);
      }
    }
  }

  const busy = readingId !== null;
  const pageSizeOptions = [...new Set([10, 20, 50, query.pageSize])].sort((a, b) => a - b);
  const emptyTitle = query.status === "UNREAD" ? "暂无未读通知" : query.status === "READ" ? "暂无已读通知" : "暂无通知";
  return (
    <div className="page-container">
      <PageHeading title="通知中心" section="我的账号"
        description="查看候补递补和活动取消消息，及时了解报名变化。"
        extra={<Button aria-label="刷新通知" icon={<ReloadOutlined aria-hidden="true" />}
          disabled={busy} loading={resource.loading} onClick={() => { setMutationError(null); resource.retry(); }}>刷新通知</Button>} />
      <Card className="notification-controls">
        <div className="notification-filters">
          <label htmlFor="notification-status">通知状态</label>
          <Select id="notification-status" aria-label="通知状态" value={query.status} disabled={busy}
            options={[
              { value: "ALL", label: "全部通知" },
              { value: "UNREAD", label: "未读通知" },
              { value: "READ", label: "已读通知" },
            ]}
            onChange={(status: NotificationFilter) => changeQuery({ ...query, status, page: 1 })} />
          <span className="metadata">未读数量统计全部通知，刷新后更新。</span>
        </div>
      </Card>
      {mutationError && <Alert type="error" showIcon title={mutationError} className="form-alert" />}
      {resource.loading || correctingPage ? <LoadingState /> : resource.error ? (
        <ErrorState error={resource.error} retry={resource.retry} />
      ) : !resource.data?.items.length ? (
        <EmptyState title={emptyTitle} description="候补递补成功或已报名活动取消时，通知会显示在这里。" />
      ) : (
        <>
          <section className="notification-list" data-testid="notification-list" aria-label="通知列表">
            {resource.data.items.map((item) => (
              <article key={item.id} data-testid={`notification-${item.id}`} data-notification-id={item.id}
                className={`notification-item ${item.readAt ? "" : "notification-unread"}`}>
                <div className="notification-content">
                  <div className="notification-tags">
                    <Tag color={item.type === "PROMOTED" ? "success" : "warning"}>
                      {item.type === "PROMOTED" ? "候补递补成功" : "活动已取消"}
                    </Tag>
                    <Tag color={item.readAt ? "default" : "blue"}>{item.readAt ? "已读" : "未读"}</Tag>
                  </div>
                  <h2>{item.activityTitle}</h2>
                  <p className="notification-description">{item.type === "PROMOTED"
                    ? "你已从候补队列递补为有效报名者，可查看活动详情确认安排。"
                    : "你参与的活动已取消，报名与候补已关闭，历史记录保留。"}</p>
                  {item.cancellationReason && <p className="notification-reason">取消原因：{item.cancellationReason}</p>}
                  <p className="metadata">通知时间（北京时间）：{formatDate(item.createdAt)} {formatTime(item.createdAt)}</p>
                  {item.readAt && <p className="metadata">已读时间（北京时间）：{formatDate(item.readAt)} {formatTime(item.readAt)}</p>}
                </div>
                <div className="notification-item-actions">
                  <Link to={`/activities/${item.activityId}`} aria-label={`查看通知活动 ${item.activityTitle}`}>查看活动</Link>
                  <Button aria-label={`标记通知 ${item.id} 为已读`} icon={<CheckOutlined aria-hidden="true" />}
                    disabled={!!item.readAt || busy} loading={readingId === item.id} onClick={() => void read(item.id)}>
                    {item.readAt ? "已读" : "标记已读"}
                  </Button>
                </div>
              </article>
            ))}
          </section>
          <Card className="notification-pagination">
            <Pagination aria-label="通知分页" current={query.page} pageSize={query.pageSize} total={resource.data.total}
              responsive showLessItems disabled={busy} showSizeChanger={{ "aria-label": "每页通知数量" }}
              pageSizeOptions={pageSizeOptions} showTotal={(total) => `共 ${total} 条通知`}
              onChange={(page, pageSize) => changeQuery({ ...query, page: pageSize === query.pageSize ? page : 1, pageSize })} />
          </Card>
        </>
      )}
    </div>
  );
}
