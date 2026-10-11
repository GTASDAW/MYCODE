import { useEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Card, Descriptions, Modal, Select, Statistic } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { Link, useParams } from "react-router";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import {
  ActivityStatus,
  ActivityCancellationNotice,
  ErrorState,
  LoadingState,
  PageHeading,
} from "../components";
import { formatDate, formatTime } from "../date";
import { downloadCsv } from "../fileDownload";
import { canCheckInRegistration } from "../registrationCheckIn";
import type {
  AdminRegistration,
  AdminRegistrationQuery,
  CheckInFilter,
  RegistrationFilter,
} from "../types";
import { useResource } from "../useResource";
import { AdminRegistrationTable } from "./AdminRegistrationTable";
import { useRosterActions } from "./useRosterActions";

const dateTime = (value: string) => `${formatDate(value)} ${formatTime(value)}`;
export function AdminRegistrationsRoute() {
  const { id } = useParams();
  const auth = useAuth();
  const account = auth.captureAccountRequest();
  return <AdminRegistrationsPage key={`${id}:${account?.userId}:${account?.generation}`} />;
}

function AdminRegistrationsPage() {
  const { id = "" } = useParams();
  const auth = useAuth();
  const { message } = AntApp.useApp();
  const account = auth.captureAccountRequest();
  const accountKey = `${account?.userId}:${account?.generation}`;
  const [query, setQuery] = useState<AdminRegistrationQuery>({
    page: 1,
    pageSize: 10,
    status: "ALL",
    checkInStatus: "ALL",
  });
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<AdminRegistration | null>(null);
  const pageKey = `${id}:${accountKey}:${query.page}:${query.pageSize}:${query.status}:${query.checkInStatus}:${revision}`;
  const currentPage = useRef(pageKey);
  currentPage.current = pageKey;
  const actions = useRosterActions(pageKey);
  const refresh = () => setRevision((value) => value + 1);
  const resource = useResource(
    async (signal) => {
      const ticket = auth.captureAccountRequest();
      const startedPage = pageKey;
      const current = () => !!ticket && !signal.aborted && currentPage.current === startedPage && auth.isCurrentAccountRequest(ticket);
      const cancelled = () => new DOMException("Roster request cancelled", "AbortError");
      if (!ticket || auth.user?.role !== "ADMIN" || !current()) throw cancelled();
      try {
        const result = await api.adminRegistrations(id, query, signal);
        if (!current()) throw cancelled();
        return result;
      } catch (err) {
        if (!current()) throw cancelled();
        if (err instanceof ApiError && err.status === 401) auth.expire();
        throw err;
      }
    },
    [id, accountKey, query.page, query.pageSize, query.status, query.checkInStatus, revision],
  );
  useEffect(() => setSelected(null), [pageKey]);
  useEffect(() => {
    if (resource.loading || resource.error || !resource.data) return;
    const lastPage = Math.max(
      1,
      Math.ceil(resource.data.total / query.pageSize),
    );
    if (query.page <= lastPage) return;
    // Ignore a queued correction if the user has already changed this query.
    setQuery((previous) =>
      previous === query ? { ...previous, page: lastPage } : previous,
    );
  }, [resource.data, resource.loading, resource.error, query]);
  const activity = resource.data?.activity;
  const summary = resource.data?.summary;
  const correctingPage = !!resource.data && query.page > Math.max(1, Math.ceil(resource.data.total / query.pageSize));
  const canConfirm = !!selected && !!activity && canCheckInRegistration(activity, selected);

  function confirmCheckIn() {
    if (!selected || !canConfirm) return;
    const registration = selected;
    void actions.run("checkIn", (signal) => api.checkInRegistration(id, registration.id, signal), () => {
      setSelected(null);
      message.success("签到成功，名单已刷新");
      refresh();
    });
  }

  function exportCsv() {
    if (!activity) return;
    const filters = { status: query.status, checkInStatus: query.checkInStatus };
    const filename = `activity-${activity.id}-registrations.csv`;
    void actions.run("export", (signal) => api.exportAdminRegistrations(id, filters, signal), (blob, isCurrent) => {
      downloadCsv(blob, filename, isCurrent);
    });
  }
  return (
    <div className="page-container">
      <PageHeading
        title="报名名单"
        section="活动管理"
        description={activity ? activity.title : "查看活动参与者、签到情况及导出名单。"}
        extra={
          <Link to="/admin/activities">
            <Button>返回活动管理</Button>
          </Link>
        }
      />
      {activity ? (
        <Card title="活动概况" className="activity-summary">
          <ActivityCancellationNotice activity={activity} />
          <Descriptions
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              {
                key: "title",
                label: "活动名称",
                children: (
                  <Link to={`/activities/${activity.id}`}>
                    {activity.title}
                  </Link>
                ),
              },
              {
                key: "time",
                label: "开始时间",
                children: dateTime(activity.startsAt),
              },
              {
                key: "location",
                label: "活动地点",
                children: activity.location,
              },
              {
                key: "count",
                label: "有效报名",
                children: `${activity.registeredCount} / ${activity.capacity} 人`,
              },
              {
                key: "waiting",
                label: "候补人数",
                children: `${activity.waitingCount ?? 0} 人`,
              },
              {
                key: "remaining",
                label: "可报名剩余",
                children: `${activity.closed ? 0 : Math.max(0, activity.capacity - activity.registeredCount)} 个`,
              },
              {
                key: "status",
                label: "活动状态",
                children: (
                  <ActivityStatus activity={activity} personal={false} />
                ),
              },
            ]}
          />
        </Card>
      ) : (
        resource.loading && <LoadingState />
      )}
      <section className="roster-overview" aria-label="整场活动签到统计">
        {[
          { title: "有效报名人数", value: summary?.activeRegistrations, testId: "roster-active-count" },
          { title: "已签到人数", value: summary?.checkedInRegistrations, testId: "roster-checked-in-count" },
          { title: "未签到人数", value: summary?.notCheckedInRegistrations, testId: "roster-not-checked-in-count" },
        ].map((stat) => <Card className="stat-card" key={stat.testId}>
          <Statistic title={stat.title} value={stat.value ?? "—"} suffix="人"
            formatter={() => <span data-testid={stat.testId}>{stat.value ?? "—"}</span>} />
          <p className="roster-stat-note">统计整场活动的有效报名者</p>
        </Card>)}
      </section>
      <Card title="参与者记录" className="table-card">
        <div className="filter-form">
          <div className="filter-field filter-select">
            <label htmlFor="registration-status">报名状态</label>
            <Select<RegistrationFilter>
              id="registration-status"
              aria-label="报名状态"
              value={query.status}
              onChange={(status) =>
                setQuery((previous) => ({ ...previous, page: 1, status }))
              }
              options={[
                { value: "ALL", label: "全部记录" },
                { value: "ACTIVE", label: "已报名" },
                { value: "WAITING", label: "候补中" },
                { value: "CANCELLED", label: "已取消" },
              ]}
            />
          </div>
          <div className="filter-field filter-select">
            <label htmlFor="registration-check-in-status">签到状态</label>
            <Select<CheckInFilter> id="registration-check-in-status" aria-label="签到状态" value={query.checkInStatus}
              onChange={(checkInStatus) => setQuery((previous) => ({ ...previous, page: 1, checkInStatus }))}
              options={[
                { value: "ALL", label: "全部签到状态" },
                { value: "CHECKED_IN", label: "已签到" },
                { value: "NOT_CHECKED_IN", label: "未签到" },
              ]} />
          </div>
          <div className="filter-actions roster-actions">
            <Button aria-label="刷新名单" icon={<ReloadOutlined aria-hidden="true" />} loading={resource.loading}
              disabled={actions.busy} onClick={() => { actions.clearError(); refresh(); }}>刷新名单</Button>
            <Button aria-label="导出 CSV" icon={<DownloadOutlined aria-hidden="true" />} loading={actions.operation === "export"}
              disabled={actions.busy || resource.loading || !!resource.error || !activity}
              onClick={exportCsv}>导出 CSV</Button>
          </div>
          <span className="filter-note">
            未签到只包括有效报名者；导出全部符合筛选条件的记录。
          </span>
        </div>
        {activity && !activity.cancelled && <p className="roster-guidance metadata">
          {activity.closed ? "活动已开始，可确认有效报名者到场。签到后不可撤销，支持补录。" : "活动开始后开放签到，到达开始时间请刷新名单。"}
        </p>}
        {actions.error && !selected && <Alert type="error" showIcon title={actions.error} className="form-alert" />}
        {resource.error ? (
          <ErrorState error={resource.error} retry={refresh} />
        ) : (
          <AdminRegistrationTable activity={activity} items={resource.data?.items ?? []}
            loading={resource.loading || correctingPage} busy={actions.busy}
            onCheckIn={(registration) => { actions.clearError(); setSelected(registration); }}
            pagination={correctingPage ? false : {
              current: query.page,
              pageSize: query.pageSize,
              total: resource.data?.total ?? 0,
              showSizeChanger: { "aria-label": "每页名单数量" },
              pageSizeOptions: [10, 20, 50],
              showTotal: (total) => `共 ${total} 条记录`,
              onChange: (page, pageSize) =>
                setQuery((previous) => ({
                  ...previous,
                  page: pageSize === previous.pageSize ? page : 1,
                  pageSize,
                })),
            }}
          />
        )}
      </Card>
      <Modal title="确认签到" open={!!selected} destroyOnHidden onCancel={() => { if (!actions.busy) setSelected(null); }}
        closable={!actions.busy} maskClosable={!actions.busy}
        footer={[
          <Button key="cancel" aria-label="取消签到确认" disabled={actions.busy} onClick={() => setSelected(null)}>取消</Button>,
          <Button key="confirm" type="primary" aria-label="确认签到" loading={actions.operation === "checkIn"}
            disabled={actions.busy || !canConfirm} onClick={confirmCheckIn}>确认签到</Button>,
        ]}>
        <p>确认 <strong>{selected?.displayName}</strong>（{selected?.username}）已经到场？</p>
        <p className="metadata">签到会记录当前管理员与首次签到时间，成功后不可撤销。</p>
        {actions.error && <Alert type="error" showIcon title={actions.error} />}
      </Modal>
    </div>
  );
}
