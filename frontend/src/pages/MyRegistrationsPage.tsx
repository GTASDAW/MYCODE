import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Input, Pagination, Select, Statistic, Tag } from "antd";
import { CalendarOutlined, EnvironmentOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Link, useLocation, useNavigate } from "react-router";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { readAccountResource } from "../authRequestGuard";
import {
  DateBadge,
  ActivityCancellationNotice,
  ActivityStatus,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
} from "../components";
import { formatActivityEnd, formatDate, formatRegistrationDeadline, formatTime } from "../date";
import { useActivityClock } from "../useActivityClock";
import { useResource } from "../useResource";
import { checkInLabel } from "../registrationCheckIn";
import { myRegistrationDetailsPath } from "../activityDetailNavigation";
import {
  myRegistrationListPath,
  myRegistrationKeywordLimit,
  readMyRegistrationQuery,
  serializeMyRegistrationQuery,
} from "../myRegistrationQuery";
import type { MyRegistrationQuery, RegistrationFilter } from "../types";
import { WaitingPositionNotice } from "../components/WaitingPositionNotice";

const statistics = [
  { key: "activeRegistrations", title: "已报名" },
  { key: "waitingRegistrations", title: "候补" },
  { key: "cancelledRegistrations", title: "已取消" },
  { key: "checkedInRegistrations", title: "已签到" },
] as const;

export function MyRegistrationsPage() {
  const auth = useAuth();
  const { search, key: locationKey } = useLocation();
  const navigate = useNavigate();
  const { query, notice } = readMyRegistrationQuery(search);
  const keyword = query.keyword ?? "";
  const canonicalSearch = serializeMyRegistrationQuery(query);
  const [keywordDraft, setKeywordDraft] = useState(keyword);
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const [normalizationNotice, setNormalizationNotice] = useState<string | null>(notice);
  const [revision, setRevision] = useState(0);
  const account = auth.captureAccountRequest();
  const accountKey = account ? `${account.userId}:${account.generation}` : null;
  const scope = `${accountKey}:${canonicalSearch}:${revision}`;
  const currentScope = useRef<string | null>(scope);
  const pendingNavigation = useRef<string | null>(null);
  if (pendingNavigation.current !== null && pendingNavigation.current !== locationKey)
    pendingNavigation.current = null;
  currentScope.current = scope;
  const current = () => currentScope.current === scope && pendingNavigation.current === null &&
    !!account && auth.isCurrentAccountRequest(account);
  useLayoutEffect(() => {
    currentScope.current = scope;
    return () => { if (currentScope.current === scope) currentScope.current = null; };
  }, [scope]);
  const resource = useResource((signal) => readAccountResource(
    (requestSignal) => api.searchRegistrations(query, requestSignal),
    signal,
    current,
    (error) => {
      if (error instanceof ApiError && error.status === 401) auth.expire();
    },
  ), [scope]);
  const loading = resource.loading || pendingNavigation.current !== null;
  const records = resource.data?.items ?? [];
  const now = useActivityClock(records.map(record => record.activity));
  const total = resource.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const correctingPage = !loading && !resource.error && !!resource.data && query.page > lastPage;
  const hasFilter = keyword !== "" || query.status !== "ALL";

  useEffect(() => {
    if (!current()) return;
    setKeywordDraft(keyword);
    setKeywordError(null);
    if (notice) setNormalizationNotice(notice);
    if (search !== canonicalSearch)
      navigate(`/my-registrations${canonicalSearch}`, { replace: true });
  }, [search, canonicalSearch, keyword, notice, navigate]);

  useEffect(() => {
    if (correctingPage && current())
      navigate(myRegistrationListPath({ ...query, page: lastPage }), { replace: true });
  }, [correctingPage, lastPage, scope, keyword, query.status, query.page, query.pageSize, navigate]);

  function refresh() {
    currentScope.current = null;
    setRevision(value => value + 1);
  }

  function changeQuery(next: MyRegistrationQuery) {
    setNormalizationNotice(null);
    if (serializeMyRegistrationQuery(next) === canonicalSearch) refresh();
    else {
      // Invalidate the old read immediately, including while Router queues the
      // destination. A stale 401 or out-of-range correction must not win it.
      pendingNavigation.current = locationKey;
      currentScope.current = null;
      navigate(myRegistrationListPath(next));
    }
  }

  function clearFilters() {
    setKeywordDraft("");
    setKeywordError(null);
    changeQuery({ page: 1, pageSize: query.pageSize, status: "ALL" });
  }

  const pageSizeOptions = [...new Set([10, 20, 50, query.pageSize])].sort((a, b) => a - b);
  return (
    <div className="page-container">
      <PageHeading title="我的报名" section="我的账号"
        description="查看报名、候补和本人签到结果；打开活动详情可取消或重新报名。"
        extra={<Button aria-label="刷新报名" icon={<ReloadOutlined aria-hidden="true" />}
          loading={loading} onClick={refresh}>刷新报名</Button>} />
      <div className="overview-grid myregistrations-overview">
        {statistics.map(({ key, title }) => (
          <Card className="stat-card" key={key} data-testid={`myregistrations-${key}`}>
            <Statistic title={title} value={loading || resource.error ? "—" : resource.data?.summary[key] ?? "—"}
              suffix="场" />
            <p className="metadata">{key === "checkedInRegistrations" ? "本人全部有效报名中的签到记录" : "本人全部报名记录"}</p>
          </Card>
        ))}
      </div>
      {normalizationNotice && <Alert className="discovery-notice" type="warning" showIcon closable
        title={normalizationNotice} onClose={() => setNormalizationNotice(null)} />}
      <Card className="myregistrations-controls">
        <form className="filter-form" onSubmit={event => {
          event.preventDefault();
          if (keywordDraft.length > myRegistrationKeywordLimit) {
            setKeywordError("搜索关键词最多 200 个字符，请缩短后再查询。");
            return;
          }
          setKeywordError(null);
          changeQuery({ ...query, keyword: keywordDraft, page: 1 });
        }}>
          <div className="filter-field">
            <label htmlFor="myregistration-keyword">搜索报名活动</label>
            <Input id="myregistration-keyword" aria-label="搜索报名活动" placeholder="搜索活动标题或地点"
              value={keywordDraft} maxLength={myRegistrationKeywordLimit} allowClear
              status={keywordError ? "error" : undefined}
              aria-invalid={!!keywordError} aria-describedby={keywordError ? "myregistration-keyword-error" : undefined}
              onChange={event => { setKeywordDraft(event.target.value); setKeywordError(null); }} />
          </div>
          <div className="filter-field filter-select">
            <label htmlFor="myregistration-status">报名状态</label>
            <Select<RegistrationFilter> id="myregistration-status" aria-label="报名状态" value={query.status}
              options={[
                { value: "ALL", label: "全部状态" },
                { value: "ACTIVE", label: "已报名" },
                { value: "WAITING", label: "候补" },
                { value: "CANCELLED", label: "已取消" },
              ]}
              onChange={(status) => changeQuery({ ...query, status, page: 1 })} />
          </div>
          <div className="filter-actions">
            <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden="true" />}>查询</Button>
            <Button onClick={clearFilters}>重置</Button>
          </div>
        </form>
        {keywordError && <p id="myregistration-keyword-error" role="alert">{keywordError}</p>}
        <p className="metadata">统计覆盖全部记录，不受当前关键词、状态筛选和分页影响。</p>
      </Card>
      {loading || correctingPage ? (
        <LoadingState />
      ) : resource.error ? (
        <ErrorState error={resource.error} retry={refresh} />
      ) : records.length === 0 ? (
        <EmptyState title={hasFilter ? "暂无符合条件的报名记录" : "还没有报名记录"}
          description={hasFilter ? "可以更换关键词或报名状态，或清除筛选查看全部记录。" : "选择一场感兴趣的活动，报名后可以在这里查看。"}
          action={hasFilter ? <Button onClick={clearFilters}>清除筛选</Button> : (
            <Link to="/activities"><Button type="primary">去发现活动</Button></Link>
          )} />
      ) : (
        <Card title="报名记录" extra={<span className="metadata">当前筛选共 {total} 条记录</span>}>
          <div className="registration-list" aria-label="我的报名记录">
            {records.map((record) => {
              const { id, status, activity, checkedInAt } = record;
              const detailPath = myRegistrationDetailsPath(activity.id, myRegistrationListPath(query));
              return (
                <article className="registration-row" key={id} data-registration-id={id} data-testid={`myregistration-${id}`}>
                  <DateBadge startsAt={activity.startsAt} />
                  <div className="registration-row-main">
                    <h2><Link to={detailPath}>{activity.title}</Link></h2>
                    <p><CalendarOutlined aria-hidden="true" />{formatDate(activity.startsAt)} · {formatTime(activity.startsAt)}</p>
                    <p>结束时间（北京时间）：{formatActivityEnd(activity.endsAt)}</p>
                    <p>报名截止（北京时间）：{formatRegistrationDeadline(activity.registrationDeadline)}</p>
                    <p><EnvironmentOutlined aria-hidden="true" />{activity.location}</p>
                    <ActivityCancellationNotice activity={activity} />
                    <WaitingPositionNotice activity={activity} status={status} now={now} testId={`myregistration-waiting-position-${id}`} />
                    <p className="myregistration-checkin" data-testid={`myregistration-checkin-${id}`}>
                      签到状态：{checkInLabel(record)}
                      {status === "ACTIVE" && checkedInAt && (
                        <span> · 签到时间（北京时间）：{formatDate(checkedInAt)} {formatTime(checkedInAt)}</span>
                      )}
                    </p>
                  </div>
                  <div className="registration-row-actions">
                    <Tag color={activity.cancelled ? "red" : status === "ACTIVE" ? "green" : status === "WAITING" ? "orange" : "default"}>
                      {activity.cancelled ? "活动已取消" : status === "ACTIVE" ? "已报名" : status === "WAITING" ? "候补中" : "已取消"}
                    </Tag>
                    {!activity.cancelled && <ActivityStatus activity={activity} personal={false} />}
                    <Link to={detailPath}>查看活动</Link>
                  </div>
                </article>
              );
            })}
          </div>
        </Card>
      )}
      {!loading && !resource.error && !correctingPage && total > 0 && (
        <Card className="myregistrations-pagination">
          <Pagination aria-label="报名分页" current={query.page} pageSize={query.pageSize} total={total}
            responsive showLessItems showSizeChanger={{ "aria-label": "每页报名数量" }} pageSizeOptions={pageSizeOptions}
            showTotal={(count) => `共 ${count} 条报名记录`}
            onChange={(page, pageSize) => changeQuery({ ...query, page: pageSize === query.pageSize ? page : 1, pageSize })} />
        </Card>
      )}
    </div>
  );
}
