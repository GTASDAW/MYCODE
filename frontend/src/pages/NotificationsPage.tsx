import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Modal, Pagination, Select, Space, Tag } from "antd";
import { CheckOutlined, ReloadOutlined } from "@ant-design/icons";
import { Link, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth";
import { EmptyState, ErrorState, LoadingState, PageHeading } from "../components";
import { formatDate, formatTime } from "../date";
import { useNotifications } from "../notifications";
import { parseNotificationQuery, serializeNotificationQuery } from "../notificationQuery";
import type { NotificationFilter, NotificationQuery, NotificationTypeFilter } from "../types";
import { useResource } from "../useResource";
import { useNotificationActions } from "./useNotificationActions";

export function NotificationsPage() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const auth = useAuth();
  const { accountKey, loadNotifications, unreadCount, countLoading, countError } = useNotifications();
  const query = useMemo(() => parseNotificationQuery(search), [search]);
  const querySearch = serializeNotificationQuery(query);
  const account = auth.captureAccountRequest();
  const [revision, setRevision] = useState(0);
  const nextRevision = useRef(revision);
  const makePageKey = (criteria: string, value: number) => `${pathname}:${accountKey}:${criteria}:${value}`;
  const pageKey = makePageKey(querySearch, revision);
  const currentPage = useRef<string | null>(pageKey);
  currentPage.current = pageKey;
  const current = () => currentPage.current === pageKey && !!account && auth.isCurrentAccountRequest(account);
  useLayoutEffect(() => {
    currentPage.current = pageKey;
    return () => { if (currentPage.current === pageKey) currentPage.current = null; };
  }, [pageKey]);

  function refresh() {
    if (!current()) return pageKey;
    const value = ++nextRevision.current;
    const nextKey = makePageKey(querySearch, value);
    // Invalidate synchronously, including the interval before React renders.
    currentPage.current = nextKey;
    setRevision(value);
    return nextKey;
  }
  const actions = useNotificationActions(pageKey, current, refresh);
  const resource = useResource((signal) => loadNotifications(query, signal, current), [pageKey, loadNotifications]);

  useEffect(() => {
    if (current() && search !== querySearch) navigate({ pathname, search: querySearch }, { replace: true });
  }, [search, querySearch, pageKey, navigate]);

  const lastPage = resource.data ? Math.max(1, Math.ceil(resource.data.total / query.pageSize)) : query.page;
  const correctingPage = !resource.loading && !resource.error && !!resource.data && query.page > lastPage;
  useEffect(() => {
    if (!correctingPage || !current()) return;
    const correctedSearch = serializeNotificationQuery({ ...query, page: lastPage });
    const correctedKey = makePageKey(correctedSearch, revision);
    actions.carryError(correctedKey);
    currentPage.current = correctedKey;
    navigate({ pathname, search: correctedSearch }, { replace: true });
  }, [correctingPage, lastPage, pageKey, navigate]);

  function changeQuery(next: NotificationQuery) {
    if (!current() || actions.isBusy()) return;
    const nextSearch = serializeNotificationQuery(next);
    if (nextSearch === querySearch) refresh();
    else navigate({ pathname, search: nextSearch });
  }

  const busy = actions.busy;
  const bulkDisabled = busy || resource.loading || !!resource.error || countLoading || !!countError || unreadCount === null || unreadCount === 0;
  const pageSizeOptions = [...new Set([10, 20, 50, query.pageSize])].sort((a, b) => a - b);
  const emptyTitle = query.status === "UNREAD" ? "暂无未读通知" : query.status === "READ" ? "暂无已读通知" : "暂无通知";
  return (
    <div className="page-container">
      <PageHeading title="通知中心" section="我的账号"
        description="查看候补递补和活动取消消息，及时了解报名变化。"
        extra={<Space wrap>
          <Button aria-label="全部标为已读" title="全部标为已读" icon={<CheckOutlined aria-hidden="true" />}
            disabled={bulkDisabled} onClick={actions.openConfirmation}>全部标为已读</Button>
          <Button aria-label="刷新通知" icon={<ReloadOutlined aria-hidden="true" />}
            disabled={busy} loading={resource.loading} onClick={() => { if (!actions.isBusy()) refresh(); }}>刷新通知</Button>
        </Space>} />
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
          <label htmlFor="notification-type">通知类型</label>
          <Select id="notification-type" aria-label="通知类型" value={query.type ?? "ALL"} disabled={busy}
            options={[
              { value: "ALL", label: "全部类型" },
              { value: "PROMOTED", label: "候补递补" },
              { value: "ACTIVITY_CANCELLED", label: "活动取消" },
            ]}
            onChange={(type: NotificationTypeFilter) => changeQuery({ ...query, type, page: 1 })} />
          <span className="metadata">未读数量统计全部通知，刷新后更新。</span>
        </div>
      </Card>
      {actions.error && <Alert type="error" showIcon title={actions.error} className="form-alert" />}
      {resource.loading || correctingPage ? <LoadingState /> : resource.error ? (
        <ErrorState error={resource.error} retry={refresh} />
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
                    disabled={!!item.readAt || busy} loading={actions.operation === item.id} onClick={() => void actions.read(item.id)}>
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
      <Modal title="全部标为已读" open={actions.confirmation} destroyOnHidden
        onCancel={actions.closeConfirmation} closable={!busy} maskClosable={!busy} keyboard={!busy}
        footer={[
          <Button key="cancel" aria-label="取消全部已读" disabled={busy} onClick={actions.closeConfirmation}>取消</Button>,
          <Button key="confirm" type="primary" aria-label="确认全部已读" loading={actions.operation === "all"}
            disabled={bulkDisabled} onClick={() => void actions.readAll()}>确认全部已读</Button>,
        ]}>
        <p>覆盖所有类型和分页；处理期间新增通知保留未读</p>
      </Modal>
    </div>
  );
}
