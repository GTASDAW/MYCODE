import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Input, Select } from "antd";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Link, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { activityCategoryFilterOptions } from "../activityCategory";
import { adminActivityListPath, defaultAdminActivityQuery, parseAdminActivityQuery, serializeAdminActivityQuery } from "../adminActivityQuery";
import { ErrorState, PageHeading } from "../components";
import type { ActivityCategoryFilter, ActivityFilter, AdminActivityQuery } from "../types";
import { useAdminRead } from "./useAdminRead";
import { AdminActivityTable } from "./AdminActivityTable";

export function AdminActivitiesPage() {
  const auth = useAuth();
  const generation = auth.captureAuthenticationRequest();
  const location = useLocation();
  const navigate = useNavigate();
  const { query, notice } = parseAdminActivityQuery(location.search);
  const canonicalSearch = serializeAdminActivityQuery(query);
  const currentSearch = useRef(canonicalSearch);
  currentSearch.current = canonicalSearch;
  const [keywordDraft, setKeywordDraft] = useState(query.keyword);
  const [normalizationNotice, setNormalizationNotice] = useState(notice);
  const resource = useAdminRead(signal => api.adminActivities(query, signal), `activity-management:${canonicalSearch}`);
  const total = resource.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const correctingPage = !resource.loading && !resource.error && !!resource.data && query.page > lastPage;

  useEffect(() => {
    setKeywordDraft(query.keyword);
    if (notice) setNormalizationNotice(notice);
    if (location.search !== canonicalSearch)
      navigate(adminActivityListPath(query), { replace: true });
  }, [location.search, canonicalSearch, query.keyword, notice, navigate]);
  useEffect(() => {
    if (correctingPage && currentSearch.current === canonicalSearch && auth.isCurrentAuthenticationRequest(generation))
      navigate(adminActivityListPath({ ...query, page: lastPage }), { replace: true });
  }, [correctingPage, lastPage, generation, canonicalSearch, query.keyword, query.status, query.category, query.page, query.pageSize, navigate]);

  function changeQuery(next: AdminActivityQuery) {
    setNormalizationNotice(null);
    if (serializeAdminActivityQuery(next) === canonicalSearch) resource.retry();
    else navigate(adminActivityListPath(next));
  }
  const pageSizeOptions = [...new Set([10, 20, 50, query.pageSize])].sort((a, b) => a - b);
  return <div className="page-container">
    <PageHeading title="活动管理" section="管理后台" description="按关键词、状态和分类查询活动，编辑信息或查看报名名单。"
      extra={<Link to="/admin/activities/new"><Button type="primary" icon={<PlusOutlined aria-hidden="true" />}>发布活动</Button></Link>} />
    {normalizationNotice && <Alert className="discovery-notice" type="warning" showIcon title={normalizationNotice}
      closable onClose={() => setNormalizationNotice(null)} />}
    <Card className="table-card" title="活动列表">
      <form className="filter-form" onSubmit={event => {
        event.preventDefault();
        changeQuery({ ...query, keyword: keywordDraft.trim(), page: 1 });
      }}>
        <div className="filter-field">
          <label htmlFor="activity-keyword">关键词</label>
          <Input id="activity-keyword" aria-label="搜索活动" placeholder="搜索活动标题或地点" value={keywordDraft}
            maxLength={200} allowClear onChange={event => setKeywordDraft(event.target.value)} />
        </div>
        <div className="filter-field filter-select">
          <label htmlFor="activity-status">活动状态</label>
          <Select<ActivityFilter> id="activity-status" aria-label="活动状态" value={query.status}
            onChange={status => changeQuery({ ...query, status, page: 1 })} options={[
              { value: "ALL", label: "全部状态" }, { value: "OPEN", label: "报名中" },
              { value: "FULL", label: "已满员" }, { value: "STARTED", label: "已开始" },
              { value: "UPCOMING", label: "即将开始" }, { value: "CANCELLED", label: "已取消" },
            ]} />
        </div>
        <div className="filter-field filter-select">
          <label htmlFor="activity-category">活动分类</label>
          <Select<ActivityCategoryFilter> id="activity-category" aria-label="活动分类" value={query.category}
            options={activityCategoryFilterOptions} onChange={category => changeQuery({ ...query, category, page: 1 })} />
        </div>
        <div className="filter-actions">
          <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden="true" />}>查询</Button>
          <Button onClick={() => { setKeywordDraft(""); changeQuery({ ...defaultAdminActivityQuery, pageSize: query.pageSize }); }}>重置</Button>
          <Button aria-label="刷新活动" icon={<ReloadOutlined aria-hidden="true" />} loading={resource.loading} onClick={resource.retry}>刷新活动</Button>
        </div>
      </form>
      {resource.error ? <ErrorState error={resource.error} retry={resource.retry} /> : <AdminActivityTable
        activities={resource.data?.items ?? []} loading={resource.loading || correctingPage} onChanged={resource.retry}
        pagination={correctingPage ? false : {
          current: query.page, pageSize: query.pageSize, total, showSizeChanger: { "aria-label": "每页管理活动数量" }, pageSizeOptions,
          showTotal: count => `共 ${count} 场活动`,
          onChange: (page, pageSize) => changeQuery({ ...query, page: pageSize === query.pageSize ? page : 1, pageSize }),
        }} />}
    </Card>
  </div>;
}
