import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, App as AntApp, Button, Card, Descriptions, Input, Modal, Select, Statistic } from "antd";
import { DownloadOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import {
  ActivityStatus,
  ActivityCancellationNotice,
  ErrorState,
  LoadingState,
  PageHeading,
} from "../components";
import { formatActivityEnd, formatDate, formatRegistrationDeadline, formatTime } from "../date";
import { activityClosed, activityRegistrationClosed } from "../activityLifecycle";
import { useActivityClock } from "../useActivityClock";
import { downloadCsv } from "../fileDownload";
import { canCheckInRegistration, canCorrectCheckInRegistration } from "../registrationCheckIn";
import type {
  AdminRegistration,
  AdminRegistrationQuery,
  CheckInFilter,
  RegistrationFilter,
} from "../types";
import { useResource } from "../useResource";
import { AdminRegistrationTable } from "./AdminRegistrationTable";
import { useRosterActions } from "./useRosterActions";
import { CheckInCorrectionModal } from "./CheckInCorrectionModal";
import { defaultRosterQuery, parseRosterQuery, rosterActivityDetailsPath, rosterListPath, serializeRosterQuery } from "../rosterQuery";

const dateTime = (value: string) => `${formatDate(value)} ${formatTime(value)}`;
export function AdminRegistrationsRoute() {
  const { id } = useParams();
  const auth = useAuth();
  const account = auth.captureAccountRequest();
  return <AdminRegistrationsPage key={`${id}:${account?.userId}:${account?.generation}`} />;
}

function AdminRegistrationsPage() {
  const { id = "" } = useParams();
  const { pathname, search, key: locationKey } = useLocation();
  const navigate = useNavigate();
  const auth = useAuth();
  const { message } = AntApp.useApp();
  const generation = useSyncExternalStore(auth.subscribeAuthentication,
    auth.captureAuthenticationRequest, auth.captureAuthenticationRequest);
  const account = auth.userGeneration === generation ? auth.captureAccountRequest() : null;
  const accountKey = `${account?.userId}:${account?.generation}`;
  const { query, notice } = parseRosterQuery(search);
  const canonicalSearch = serializeRosterQuery(query);
  const [keywordDraft, setKeywordDraft] = useState(query.keyword);
  const [normalizationNotice, setNormalizationNotice] = useState(notice);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<{ pageKey: string; registration: AdminRegistration; correcting: boolean } | null>(null);
  const pageKey = `${pathname}:${id}:${accountKey}:${generation}:${canonicalSearch}:${revision}`;
  const selected = selection?.pageKey === pageKey ? selection.registration : null;
  const correcting = !!selected && selection!.correcting;
  const currentPage = useRef<string | null>(pageKey);
  const pendingNavigation = useRef<string | null>(null);
  if (pendingNavigation.current !== null && pendingNavigation.current !== locationKey)
    pendingNavigation.current = null;
  currentPage.current = pageKey;
  useLayoutEffect(() => {
    currentPage.current = pageKey;
    return () => { if (currentPage.current === pageKey) currentPage.current = null; };
  }, [pageKey]);
  const current = () => !!account && auth.user?.role === "ADMIN" && currentPage.current === pageKey &&
    pendingNavigation.current === null && account.generation === auth.userGeneration &&
    auth.isCurrentAuthenticationRequest(auth.userGeneration) && auth.isCurrentAccountRequest(account);
  const actions = useRosterActions(pageKey, current);
  const refresh = () => {
    if (!current()) return;
    currentPage.current = null;
    setRevision((value) => value + 1);
  };
  const resource = useResource(
    async (signal) => {
      const cancelled = () => new DOMException("Roster request cancelled", "AbortError");
      const active = () => !signal.aborted && current();
      if (!active()) throw cancelled();
      try {
        const result = await api.adminRegistrations(id, query, signal);
        if (!active()) throw cancelled();
        return result;
      } catch (err) {
        if (!active()) throw cancelled();
        if (err instanceof ApiError && err.status === 401) auth.expire();
        throw err;
      }
    },
    [pageKey],
  );
  useEffect(() => setSelection(null), [pageKey]);
  useEffect(() => {
    if (!current()) return;
    setKeywordDraft(query.keyword);
    if (notice) setNormalizationNotice(notice);
    if (search !== canonicalSearch) navigate(rosterListPath(id, query), { replace: true });
  }, [pathname, search, canonicalSearch, query.keyword, notice, accountKey, navigate]);
  const lastPage = Math.max(1, Math.ceil((resource.data?.total ?? 0) / query.pageSize));
  const correctingPage = !resource.loading && !resource.error && !!resource.data && query.page > lastPage;
  useEffect(() => {
    if (correctingPage && current()) navigate(rosterListPath(id, { ...query, page: lastPage }), { replace: true });
  }, [correctingPage, lastPage, pageKey, navigate]);
  const activity = resource.data?.activity;
  const now = useActivityClock([activity]);
  const summary = resource.data?.summary;
  const canConfirm = !!selected && !!activity && canCheckInRegistration(activity, selected, now);
  const canCorrect = !!selected && !!activity && canCorrectCheckInRegistration(activity, selected, now);

  function changeQuery(next: AdminRegistrationQuery) {
    if (!current()) return;
    setNormalizationNotice(null);
    if (serializeRosterQuery(next) === canonicalSearch) refresh();
    else {
      pendingNavigation.current = locationKey;
      currentPage.current = null;
      navigate(rosterListPath(id, next));
    }
  }

  function refreshAfterWriteError(error: unknown) {
    if (!current()) return;
    if (error instanceof ApiError && error.code === "CHECK_IN_VERSION_CONFLICT") {
      setSelection(null);
      message.warning("签到状态已变化，请核对刷新后的名单再操作。");
    }
    resource.retry();
  }

  function confirmCheckIn() {
    if (!selected || !canConfirm || !current()) return;
    const registration = selected;
    void actions.run("checkIn", (signal) => api.checkInRegistration(id, registration.id, signal, registration.checkInVersion), () => {
      setSelection(null);
      message.success("签到成功，名单已刷新");
      resource.retry();
    }, refreshAfterWriteError);
  }

  function correctCheckIn(checkedIn: boolean, reason: string) {
    if (!selected || !correcting || !canCorrect || !current() || checkedIn === !!selected.checkedInAt) return;
    const registration = selected;
    void actions.run("correctCheckIn", signal => api.correctRegistrationCheckIn(id, registration.id,
      { checkedIn, reason, expectedVersion: registration.checkInVersion }, signal), () => {
      setSelection(null);
      message.success("签到已更正，名单已刷新");
      resource.retry();
    }, refreshAfterWriteError);
  }

  function exportCsv() {
    if (!activity || !current()) return;
    const filters = { status: query.status, checkInStatus: query.checkInStatus, keyword: query.keyword };
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
      {normalizationNotice && <Alert className="discovery-notice" type="warning" showIcon title={normalizationNotice}
        closable onClose={() => setNormalizationNotice(null)} />}
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
                  <Link to={rosterActivityDetailsPath(activity.id, query)}>
                    {activity.title}
                  </Link>
                ),
              },
              {
                key: "time",
                label: "开始时间",
                children: dateTime(activity.startsAt),
              },
              { key: "end-time", label: "结束时间", children: formatActivityEnd(activity.endsAt) },
              { key: "registration-deadline", label: "报名截止", children: formatRegistrationDeadline(activity.registrationDeadline) },
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
                children: `${activityRegistrationClosed(activity) ? 0 : Math.max(0, activity.capacity - activity.registeredCount)} 个`,
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
        <form className="filter-form" onSubmit={event => {
          event.preventDefault();
          changeQuery({ ...query, keyword: keywordDraft.trim(), page: 1 });
        }}>
          <div className="filter-field">
            <label htmlFor="roster-keyword">搜索报名人员</label>
            <Input id="roster-keyword" aria-label="搜索报名人员" placeholder="搜索账号或昵称" value={keywordDraft}
              maxLength={200} allowClear onChange={event => setKeywordDraft(event.target.value)} />
          </div>
          <div className="filter-field filter-select">
            <label htmlFor="registration-status">报名状态</label>
            <Select<RegistrationFilter>
              id="registration-status"
              aria-label="报名状态"
              value={query.status}
              onChange={(status) => changeQuery({ ...query, page: 1, status })}
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
              onChange={(checkInStatus) => changeQuery({ ...query, page: 1, checkInStatus })}
              options={[
                { value: "ALL", label: "全部签到状态" },
                { value: "CHECKED_IN", label: "已签到" },
                { value: "NOT_CHECKED_IN", label: "未签到" },
              ]} />
          </div>
          <div className="filter-actions roster-actions">
            <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden="true" />}>查询</Button>
            <Button aria-label="重置" onClick={() => { setKeywordDraft(""); changeQuery({ ...defaultRosterQuery, pageSize: query.pageSize }); }}>重置</Button>
            <Button aria-label="刷新名单" icon={<ReloadOutlined aria-hidden="true" />} loading={resource.loading}
              disabled={actions.busy} onClick={() => { actions.clearError(); refresh(); }}>刷新名单</Button>
            <Button aria-label="导出 CSV" icon={<DownloadOutlined aria-hidden="true" />} loading={actions.operation === "export"}
              disabled={actions.busy || resource.loading || !!resource.error || !activity}
              onClick={exportCsv}>导出 CSV</Button>
          </div>
          <span className="filter-note">
            未签到只包括有效报名者；导出全部符合筛选条件的记录。
          </span>
        </form>
        {activity && !activity.cancelled && <p className="roster-guidance metadata">
          {activityClosed(activity) ? "活动已开始，可确认有效报名者到场；补签或撤销须填写原因，活动结束后仍可更正。" : "活动开始后开放签到。"}
        </p>}
        {actions.error && !selected && <Alert type="error" showIcon title={actions.error} className="form-alert" />}
        {resource.error ? (
          <ErrorState error={resource.error} retry={refresh} />
        ) : (
          <AdminRegistrationTable activity={activity} items={resource.data?.items ?? []}
            loading={resource.loading || correctingPage} busy={actions.busy}
            onCheckIn={(registration) => {
              if (!current()) return;
              actions.clearError(); setSelection({ pageKey, registration, correcting: false });
            }}
            onCorrectCheckIn={(registration) => {
              if (!current()) return;
              actions.clearError(); setSelection({ pageKey, registration, correcting: true });
            }}
            pagination={correctingPage ? false : {
              current: query.page,
              pageSize: query.pageSize,
              total: resource.data?.total ?? 0,
              showSizeChanger: { "aria-label": "每页名单数量" },
              pageSizeOptions: [...new Set([10, 20, 50, query.pageSize])].sort((a, b) => a - b),
              showTotal: (total) => `共 ${total} 条记录`,
              onChange: (page, pageSize) =>
                changeQuery({
                  ...query,
                  page: pageSize === query.pageSize ? page : 1,
                  pageSize,
                }),
            }}
          />
        )}
      </Card>
      <Modal title="确认签到" open={!!selected && !correcting} destroyOnHidden onCancel={() => { if (!actions.busy) setSelection(null); }}
        closable={!actions.busy} maskClosable={!actions.busy}
        footer={[
          <Button key="cancel" aria-label="取消签到确认" disabled={actions.busy} onClick={() => setSelection(null)}>取消</Button>,
          <Button key="confirm" type="primary" aria-label="确认签到" loading={actions.operation === "checkIn"}
            disabled={actions.busy || !canConfirm} onClick={confirmCheckIn}>确认签到</Button>,
        ]}>
        <p>确认 <strong>{selected?.displayName}</strong>（{selected?.username}）已经到场？</p>
        <p className="metadata">签到会记录当前管理员与签到时间；需要更正时须填写原因并保留审计记录。</p>
        {actions.error && <Alert type="error" showIcon title={actions.error} />}
      </Modal>
      {selected && correcting && <CheckInCorrectionModal key={`${pageKey}:${selected.id}`}
        registration={selected} busy={actions.busy} allowed={canCorrect} error={actions.error}
        onCancel={() => { if (!actions.busy && current()) setSelection(null); }} onSubmit={correctCheckIn} />}
    </div>
  );
}
