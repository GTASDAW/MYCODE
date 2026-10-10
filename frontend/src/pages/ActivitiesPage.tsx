import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Pagination, Select, Statistic } from "antd";
import { PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { Link, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  ActivityCard,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
} from "../components";
import { useResource } from "../useResource";
import type { ActivityFilter, ActivitySearchQuery } from "../types";
import {
  activityListPath,
  defaultActivityQuery,
  parseActivityQuery,
  serializeActivityQuery,
} from "../activityDiscovery";

export function ActivitiesPage() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { query, notice } = parseActivityQuery(location.search);
  const canonicalSearch = serializeActivityQuery(query);
  const [keywordDraft, setKeywordDraft] = useState(query.keyword);
  const [normalizationNotice, setNormalizationNotice] = useState<string | null>(notice);
  const resource = useResource(
    (signal) => api.searchActivities(query, signal),
    [user?.id, query.keyword, query.status, query.page, query.pageSize],
  );
  const activities = resource.data?.items ?? [];
  const total = resource.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const correctingPage = !resource.loading && !resource.error &&
    resource.data !== null && query.page > lastPage;

  useEffect(() => {
    setKeywordDraft(query.keyword);
    if (notice) setNormalizationNotice(notice);
    if (location.search !== canonicalSearch) {
      navigate({ pathname: "/activities", search: canonicalSearch }, { replace: true });
    }
  }, [location.search, canonicalSearch, query.keyword, notice, navigate]);

  useEffect(() => {
    if (resource.loading || resource.error || !resource.data) return;
    const lastPage = Math.max(1, Math.ceil(resource.data.total / query.pageSize));
    if (query.page > lastPage) {
      navigate(activityListPath({ ...query, page: lastPage }), { replace: true });
    }
  }, [
    resource.data, resource.loading, resource.error,
    query.keyword, query.status, query.page, query.pageSize, navigate,
  ]);

  function changeQuery(next: ActivitySearchQuery) {
    setNormalizationNotice(null);
    const search = serializeActivityQuery(next);
    if (search === canonicalSearch) resource.retry();
    else navigate({ pathname: "/activities", search });
  }

  function clearFilters() {
    setKeywordDraft("");
    changeQuery({ ...defaultActivityQuery, pageSize: query.pageSize });
  }

  const hasFilters = query.keyword !== "" || query.status !== "ALL";
  const pageSizeOptions = [...new Set([12, 24, 48, query.pageSize])].sort((a, b) => a - b);
  return (
    <div className="page-container">
      <PageHeading
        title="发现活动"
        description="浏览近期活动，选择感兴趣的一场参与。"
        extra={
          user?.role === "ADMIN" ? (
            <Link to="/admin/activities/new">
              <Button type="primary" icon={<PlusOutlined aria-hidden="true" />}>
                发布活动
              </Button>
            </Link>
          ) : undefined
        }
      />
      {normalizationNotice && (
        <Alert
          className="discovery-notice"
          type="warning"
          showIcon
          title={normalizationNotice}
          closable
          onClose={() => setNormalizationNotice(null)}
        />
      )}
      <Card className="discovery-filters">
        <form
          className="filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            changeQuery({ ...query, keyword: keywordDraft, page: 1 });
          }}
        >
          <div className="filter-field">
            <label htmlFor="discovery-keyword">搜索活动</label>
            <Input
              id="discovery-keyword"
              aria-label="搜索活动"
              placeholder="搜索活动标题或地点"
              value={keywordDraft}
              maxLength={200}
              allowClear
              onChange={(event) => setKeywordDraft(event.target.value)}
            />
          </div>
          <div className="filter-field filter-select">
            <label htmlFor="discovery-status">活动状态</label>
            <Select<ActivityFilter>
              id="discovery-status"
              aria-label="活动状态"
              value={query.status}
              onChange={(status) => changeQuery({ ...query, status, page: 1 })}
              options={[
                { value: "ALL", label: "全部状态" },
                { value: "OPEN", label: "报名中" },
                { value: "FULL", label: "已满员" },
                { value: "STARTED", label: "已开始" },
                { value: "CANCELLED", label: "已取消" },
                { value: "UPCOMING", label: "即将开始" },
              ]}
            />
          </div>
          <div className="filter-actions">
            <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden="true" />}>
              查询
            </Button>
            <Button onClick={clearFilters}>重置</Button>
          </div>
        </form>
      </Card>
      <div className="public-overview">
        <Card data-testid="discovery-upcomingActivities">
          <Statistic
            title="即将开始的活动"
            value={resource.loading || resource.error ? "—" : resource.data?.summary.upcomingActivities ?? "—"}
            suffix="场"
          />
          <p className="metadata">{resource.error ? "当前筛选范围 · 指标未加载" : "当前筛选范围"}</p>
        </Card>
        <Card data-testid="discovery-availableSeats">
          <Statistic
            title="可报名名额"
            value={resource.loading || resource.error ? "—" : resource.data?.summary.availableSeats ?? "—"}
            suffix="个"
          />
          <p className="metadata">{resource.error ? "当前筛选范围 · 指标未加载" : "当前筛选范围"}</p>
        </Card>
      </div>
      <section className="activities-section" id="activity-list">
        <div className="section-heading">
          <h2>{hasFilters ? "筛选结果" : "全部活动"}</h2>
          {!resource.loading && !resource.error && (
            <span className="metadata">共 {total} 场活动</span>
          )}
        </div>
        {resource.loading || correctingPage ? (
          <LoadingState cards />
        ) : resource.error ? (
          <ErrorState error={resource.error} retry={resource.retry} />
        ) : activities.length === 0 ? (
          <EmptyState
            title={hasFilters ? "暂无符合条件的活动" : "还没有发布的活动"}
            description={hasFilters ? "试试其他关键词或活动状态。" : "活动发布后会显示在这里。"}
            action={hasFilters ? <Button onClick={clearFilters}>清除筛选</Button> : undefined}
          />
        ) : (
          <div className="activity-grid">
            {activities.map((activity) => (
              <ActivityCard key={activity.id} activity={activity} from={activityListPath(query)} />
            ))}
          </div>
        )}
        {!resource.loading && !resource.error && !correctingPage && total > 0 && (
          <Card className="discovery-pagination">
            <Pagination
              aria-label="活动分页"
              current={query.page}
              pageSize={query.pageSize}
              total={total}
              responsive
              showLessItems
              showSizeChanger={{ "aria-label": "每页数量" }}
              pageSizeOptions={pageSizeOptions}
              showTotal={(count) => `共 ${count} 场活动`}
              onChange={(page, pageSize) => changeQuery({
                ...query,
                page: pageSize === query.pageSize ? page : 1,
                pageSize,
              })}
            />
          </Card>
        )}
      </section>
    </div>
  );
}
