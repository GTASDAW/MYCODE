import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Pagination, Select } from "antd";
import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { auditActionLabels } from "../auditLogPresentation";
import { auditLogListPath, parseAuditActivityId, parseAuditLogQuery, serializeAuditLogQuery } from "../auditLogQuery";
import { EmptyState, ErrorState, LoadingState, PageHeading } from "../components";
import type { AdminAuditLogQuery, AuditLogActionFilter } from "../types";
import { AdminAuditLogDetail } from "./AdminAuditLogDetail";
import { AdminAuditLogList } from "./AdminAuditLogList";
import { useAdminRead } from "./useAdminRead";
import "../adminAudit.css";

export function AdminAuditLogsPage() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const query = parseAuditLogQuery(location.search);
  const canonicalSearch = serializeAuditLogQuery(query);
  const account = auth.captureAccountRequest();
  const [revision, setRevision] = useState(0);
  const pageKey = `${canonicalSearch}:${account?.generation}:${account?.userId}:${revision}`;
  const [activityDraft, setActivityDraft] = useState(query.activityId === null ? "" : String(query.activityId));
  const [draftError, setDraftError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: number; scope: string } | null>(null);
  const resource = useAdminRead(signal => api.adminAuditLogs(query, signal), `audit-list:${pageKey}`);
  const total = resource.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const correctingPage = !!resource.data && !resource.loading && !resource.error && query.page > lastPage;

  useEffect(() => {
    if (location.search !== canonicalSearch)
      navigate(`/admin/audit-logs${canonicalSearch}`, { replace: true });
  }, [location.search, canonicalSearch, navigate]);
  useEffect(() => {
    setActivityDraft(query.activityId === null ? "" : String(query.activityId));
    setDraftError(null);
  }, [query.activityId, canonicalSearch]);
  useEffect(() => setSelected(null), [pageKey]);
  useEffect(() => {
    if (correctingPage)
      navigate(auditLogListPath({ ...query, page: lastPage }), { replace: true });
  }, [correctingPage, lastPage, query.action, query.activityId, query.page, query.pageSize, navigate]);

  function refresh() {
    setSelected(null);
    setRevision(value => value + 1);
  }
  function changeQuery(next: AdminAuditLogQuery) {
    setSelected(null);
    if (serializeAuditLogQuery(next) === canonicalSearch) refresh();
    else navigate(auditLogListPath(next));
  }
  const pageSizeOptions = [...new Set([10, 20, 50, query.pageSize])].sort((a, b) => a - b);
  return <div className="page-container">
    <PageHeading title="管理员操作记录" section="管理后台"
      description="查看活动发布、编辑、取消和管理员签到的操作记录及字段变化。"
      extra={<Button aria-label="刷新操作记录" icon={<ReloadOutlined aria-hidden="true" />} loading={resource.loading} onClick={refresh}>刷新操作记录</Button>} />
    <Card className="audit-controls">
      <form className="filter-form" onSubmit={event => {
        event.preventDefault();
        const activityId = parseAuditActivityId(activityDraft);
        if (activityDraft.trim() && activityId === null) {
          setDraftError("活动 ID 必须为正整数，且不超过 9007199254740991。");
          return;
        }
        setDraftError(null);
        setActivityDraft(activityId === null ? "" : String(activityId));
        changeQuery({ ...query, activityId, page: 1 });
      }}>
        <div className="filter-field filter-select">
          <label htmlFor="audit-action">操作类型</label>
          <Select<AuditLogActionFilter> id="audit-action" aria-label="操作类型" value={query.action}
            options={[{ value: "ALL", label: "全部类型" }, ...Object.entries(auditActionLabels).map(([value, label]) => ({ value, label }))]}
            onChange={action => changeQuery({ ...query, action, page: 1 })} />
        </div>
        <div className="filter-field">
          <label htmlFor="audit-activity-id">活动 ID</label>
          <Input id="audit-activity-id" aria-label="筛选活动 ID" value={activityDraft} placeholder="留空查看全部活动"
            inputMode="numeric" autoComplete="off" maxLength={32} allowClear
            status={draftError ? "error" : undefined} aria-invalid={!!draftError} aria-describedby={draftError ? "audit-filter-error" : undefined}
            onChange={event => { setActivityDraft(event.target.value); setDraftError(null); }} />
        </div>
        <div className="filter-actions">
          <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden="true" />}>查询记录</Button>
          <Button onClick={() => {
            setActivityDraft(""); setDraftError(null);
            changeQuery({ ...query, action: "ALL", activityId: null, page: 1 });
          }}>重置筛选</Button>
        </div>
      </form>
      {draftError && <Alert id="audit-filter-error" type="error" showIcon title={draftError} className="form-alert" />}
      <p className="metadata audit-snapshot-note">名称均为操作时快照；记录只读，时间按北京时间展示到微秒。</p>
    </Card>
    {resource.loading || correctingPage ? <LoadingState /> : resource.error ? <ErrorState error={resource.error} retry={refresh} /> :
      <Card title="操作记录" extra={<span className="metadata" data-testid="audit-total">当前筛选共 {total} 条记录</span>}>
        {resource.data?.items.length
          ? <AdminAuditLogList items={resource.data.items} onDetail={id => setSelected({ id, scope: pageKey })} />
          : <EmptyState title="暂无符合条件的操作记录" description="可以调整筛选条件，或在管理员完成活动操作后手动刷新。" />}
      </Card>}
    {!resource.loading && !resource.error && !correctingPage && total > 0 && <Card className="audit-pagination">
      <Pagination aria-label="操作记录分页" current={query.page} pageSize={query.pageSize} total={total} responsive showLessItems
        showSizeChanger={{ "aria-label": "每页操作记录数量" }} pageSizeOptions={pageSizeOptions}
        showTotal={count => `共 ${count} 条操作记录`}
        onChange={(page, pageSize) => changeQuery({ ...query, page: pageSize === query.pageSize ? page : 1, pageSize })} />
    </Card>}
    <AdminAuditLogDetail id={selected?.scope === pageKey ? selected.id : null} scope={pageKey} onClose={() => setSelected(null)} />
  </div>;
}
