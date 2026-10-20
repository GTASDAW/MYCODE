import { useEffect } from "react";
import { Button, Card, Pagination, Select, Statistic, Tag } from "antd";
import { CalendarOutlined, EnvironmentOutlined, ReloadOutlined } from "@ant-design/icons";
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
  parseMyRegistrationQuery,
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
  const { search } = useLocation();
  const navigate = useNavigate();
  const query = parseMyRegistrationQuery(search);
  const canonicalSearch = serializeMyRegistrationQuery(query);
  const account = auth.captureAccountRequest();
  const accountKey = account ? `${account.userId}:${account.generation}` : null;
  const resource = useResource((signal) => {
    const ticket = auth.captureAccountRequest();
    return readAccountResource(
      (requestSignal) => api.searchRegistrations(query, requestSignal),
      signal,
      () => !!ticket && auth.isCurrentAccountRequest(ticket),
      (error) => {
        if (error instanceof ApiError && error.status === 401) auth.expire();
      },
    );
  }, [accountKey, query.status, query.page, query.pageSize]);
  const records = resource.data?.items ?? [];
  const now = useActivityClock(records.map(record => record.activity));
  const total = resource.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const correctingPage = !resource.loading && !resource.error && !!resource.data && query.page > lastPage;
  const hasFilter = query.status !== "ALL";

  useEffect(() => {
    if (search !== canonicalSearch)
      navigate(`/my-registrations${canonicalSearch}`, { replace: true });
  }, [search, canonicalSearch, navigate]);

  useEffect(() => {
    if (correctingPage)
      navigate(myRegistrationListPath({ ...query, page: lastPage }), { replace: true });
  }, [correctingPage, lastPage, query.status, query.page, query.pageSize, navigate]);

  function changeQuery(next: MyRegistrationQuery) {
    if (serializeMyRegistrationQuery(next) === canonicalSearch) resource.retry();
    else navigate(myRegistrationListPath(next));
  }

  const pageSizeOptions = [...new Set([10, 20, 50, query.pageSize])].sort((a, b) => a - b);
  return (
    <div className="page-container">
      <PageHeading title="我的报名" section="我的账号"
        description="查看报名、候补和本人签到结果；打开活动详情可取消或重新报名。"
        extra={<Button aria-label="刷新报名" icon={<ReloadOutlined aria-hidden="true" />}
          loading={resource.loading} onClick={resource.retry}>刷新报名</Button>} />
      <div className="overview-grid myregistrations-overview">
        {statistics.map(({ key, title }) => (
          <Card className="stat-card" key={key} data-testid={`myregistrations-${key}`}>
            <Statistic title={title} value={resource.loading || resource.error ? "—" : resource.data?.summary[key] ?? "—"}
              suffix="场" />
            <p className="metadata">{key === "checkedInRegistrations" ? "本人全部有效报名中的签到记录" : "本人全部报名记录"}</p>
          </Card>
        ))}
      </div>
      <Card className="myregistrations-controls">
        <div className="myregistrations-filters">
          <label htmlFor="myregistration-status">报名状态</label>
          <Select<RegistrationFilter> id="myregistration-status" aria-label="报名状态" value={query.status}
            options={[
              { value: "ALL", label: "全部状态" },
              { value: "ACTIVE", label: "已报名" },
              { value: "WAITING", label: "候补" },
              { value: "CANCELLED", label: "已取消" },
            ]}
            onChange={(status) => changeQuery({ ...query, status, page: 1 })} />
          <span className="metadata">统计覆盖全部记录，不受当前筛选和分页影响。</span>
        </div>
      </Card>
      {resource.loading || correctingPage ? (
        <LoadingState />
      ) : resource.error ? (
        <ErrorState error={resource.error} retry={resource.retry} />
      ) : records.length === 0 ? (
        <EmptyState title={hasFilter ? "暂无符合条件的报名记录" : "还没有报名记录"}
          description={hasFilter ? "可以切换其他报名状态，或查看全部记录。" : "选择一场感兴趣的活动，报名后可以在这里查看。"}
          action={hasFilter ? <Button onClick={() => changeQuery({ ...query, status: "ALL", page: 1 })}>清除筛选</Button> : (
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
      {!resource.loading && !resource.error && !correctingPage && total > 0 && (
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
