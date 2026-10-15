import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Pagination, Statistic } from "antd";
import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { attendanceDashboardPath, attendanceRangeError, defaultAttendanceQuery, parseAttendanceQuery, serializeAttendanceQuery } from "../attendanceQuery";
import { EmptyState, ErrorState, LoadingState } from "../components";
import { formatPreciseDateTime } from "../date";
import type { AttendanceQuery } from "../types";
import { AttendanceActivityList } from "./AttendanceActivityList";
import { AttendanceRate } from "./AttendanceRate";
import { useAdminRead } from "./useAdminRead";
import "./attendance.css";

const indicators = [
  { key: "totalActivities", title: "统计活动数", suffix: "场" },
  { key: "activeRegistrations", title: "有效报名人次", suffix: "人次" },
  { key: "checkedInRegistrations", title: "已签到人次", suffix: "人次" },
  { key: "notCheckedInRegistrations", title: "未签到人次", suffix: "人次" },
] as const;

export function AttendancePanel() {
  const location = useLocation();
  const navigate = useNavigate();
  const [defaults] = useState(defaultAttendanceQuery);
  const query = parseAttendanceQuery(location.search, defaults);
  const canonicalSearch = serializeAttendanceQuery(query);
  const [draft, setDraft] = useState({ from: query.from, to: query.to });
  const [draftError, setDraftError] = useState<string | null>(null);
  const resource = useAdminRead(signal => api.adminAttendance(query, signal), `dashboard-attendance:${canonicalSearch}`);
  const summary = resource.loading || resource.error ? undefined : resource.data?.summary;
  const total = resource.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const correctingPage = !!resource.data && !resource.loading && !resource.error && query.page > lastPage;

  useEffect(() => {
    if (location.search !== canonicalSearch)
      navigate(attendanceDashboardPath(query), { replace: true });
  }, [location.search, canonicalSearch, navigate]);
  useEffect(() => {
    setDraft({ from: query.from, to: query.to });
    setDraftError(null);
  }, [canonicalSearch, query.from, query.to]);
  useEffect(() => {
    if (correctingPage)
      navigate(attendanceDashboardPath({ ...query, page: lastPage }), { replace: true });
  }, [correctingPage, lastPage, query.from, query.to, query.page, query.pageSize, navigate]);

  function changeQuery(next: AttendanceQuery) {
    if (serializeAttendanceQuery(next) === canonicalSearch) resource.retry();
    else navigate(attendanceDashboardPath(next));
  }
  const pageSizeOptions = [...new Set([10, 20, 50, query.pageSize])].sort((a, b) => a - b);
  return <section className="attendance-panel" aria-labelledby="attendance-heading" data-testid="attendance-panel">
    <Card title={<h2 id="attendance-heading">活动签到分析</h2>}
      extra={<Button aria-label="刷新签到分析" icon={<ReloadOutlined aria-hidden="true" />} loading={resource.loading}
        onClick={resource.retry}>刷新签到分析</Button>}>
      <form className="attendance-filter-form" noValidate onSubmit={event => {
        event.preventDefault();
        const error = attendanceRangeError(draft.from, draft.to);
        setDraftError(error);
        if (!error) changeQuery({ ...query, ...draft, page: 1 });
      }}>
        <div className="filter-field"><label htmlFor="attendance-from">开始日期</label>
          <Input id="attendance-from" type="date" aria-label="签到分析开始日期" min="2000-01-01" max="2100-12-31"
            value={draft.from} aria-invalid={!!draftError} onChange={event => { setDraft(previous => ({ ...previous, from: event.target.value })); setDraftError(null); }} /></div>
        <div className="filter-field"><label htmlFor="attendance-to">结束日期</label>
          <Input id="attendance-to" type="date" aria-label="签到分析结束日期" min="2000-01-01" max="2100-12-31"
            value={draft.to} aria-invalid={!!draftError} onChange={event => { setDraft(previous => ({ ...previous, to: event.target.value })); setDraftError(null); }} /></div>
        <div className="attendance-filter-actions">
          <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden="true" />}>查询签到分析</Button>
          <Button onClick={() => { const next = defaultAttendanceQuery(); setDraft({ from: next.from, to: next.to }); setDraftError(null); changeQuery({ ...next, pageSize: query.pageSize }); }}>重置日期</Button>
        </div>
      </form>
      {draftError && <Alert type="error" showIcon title={draftError} className="form-alert" />}
      <p className="metadata attendance-guidance">仅统计所选北京时间开始日期范围内，已开始且未取消的活动。未签到表示当前尚未签到，后续补录后可手动刷新。</p>
      <div className="attendance-statistics" aria-label="全量签到统计">
        {indicators.map(indicator => <Card key={indicator.key} size="small" data-testid={`attendance-summary-${indicator.key}`}>
          <Statistic title={indicator.title} value={summary?.[indicator.key] ?? "—"} suffix={indicator.suffix} />
        </Card>)}
      </div>
      <Card className="attendance-summary-rate" size="small" title="当前签到比例">
        <AttendanceRate value={summary?.checkInRate} testId="attendance-summary-checkInRate" />
        <p className="metadata">按全部筛选活动的已签到人次 ÷ 有效报名人次计算；统计不受当前分页影响。</p>
      </Card>
      {!resource.loading && !resource.error && resource.data && <p className="metadata attendance-effective-range" data-testid="attendance-effective-range">
        当前统计范围（北京时间开始日期）：{resource.data.from} 至 {resource.data.to}
      </p>}
      <p className="metadata attendance-asof" data-testid="attendance-asOf">
        {resource.loading ? "截至查询时间（北京时间）：加载中" : resource.error || !resource.data
          ? "截至查询时间（北京时间）：暂时不可用"
          : `截至查询时间（北京时间）：${formatPreciseDateTime(resource.data.asOf)}`}
      </p>
      {resource.loading || correctingPage ? <LoadingState /> : resource.error ? <ErrorState error={resource.error} retry={resource.retry} /> : <>
        <div className="attendance-list-heading"><h3>每场活动当前签到进度</h3><span className="metadata" data-testid="attendance-total">当前筛选共 {total} 场活动</span></div>
        {resource.data?.items.length ? <AttendanceActivityList items={resource.data.items} />
          : <EmptyState title="暂无符合条件的活动" description="可以调整日期范围，或在符合条件的活动开始后刷新。" />}
        {total > 0 && <Pagination className="attendance-pagination" aria-label="签到分析分页" current={query.page} pageSize={query.pageSize}
          total={total} responsive showLessItems showSizeChanger={{ "aria-label": "每页签到活动数量" }} pageSizeOptions={pageSizeOptions}
          showTotal={count => `共 ${count} 场活动`}
          onChange={(page, pageSize) => changeQuery({ ...query, page: pageSize === query.pageSize ? page : 1, pageSize })} />}
      </>}
    </Card>
  </section>;
}
