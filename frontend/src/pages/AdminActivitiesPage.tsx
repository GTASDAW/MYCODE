import { useEffect, useState } from "react";
import { Button, Card, Input, Select } from "antd";
import { PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorState, PageHeading } from "../components";
import type { ActivityFilter, AdminActivityQuery } from "../types";
import { useAuthenticatedResource } from "./useAuthenticatedResource";
import { AdminActivityTable } from "./AdminActivityTable";

export function AdminActivitiesPage() {
  const { user } = useAuth();
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState<AdminActivityQuery>({
    page: 1,
    pageSize: 10,
    keyword: "",
    status: "ALL",
  });
  const resource = useAuthenticatedResource(
    (signal) => api.adminActivities(query, signal),
    [user?.id, query.page, query.pageSize, query.keyword, query.status],
  );
  useEffect(() => {
    if (resource.loading || resource.error || !resource.data) return;
    const lastPage = Math.max(
      1,
      Math.ceil(resource.data.total / query.pageSize),
    );
    if (query.page <= lastPage) return;
    // The resource only exposes the current request's data. Also guard a queued
    // correction against a newer filter or page change before its updater runs.
    setQuery((previous) =>
      previous === query ? { ...previous, page: lastPage } : previous,
    );
  }, [resource.data, resource.loading, resource.error, query]);
  return (
    <div className="page-container">
      <PageHeading
        title="活动管理"
        section="管理后台"
        description="查询活动、查看报名人数和报名名单。"
        extra={
          <Link to="/admin/activities/new">
            <Button type="primary" icon={<PlusOutlined aria-hidden="true" />}>
              发布活动
            </Button>
          </Link>
        }
      />
      <Card className="table-card" title="活动列表">
        <form
          className="filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            const submittedKeyword = keyword.trim();
            if (query.page === 1 && query.keyword === submittedKeyword) {
              resource.retry();
              return;
            }
            setQuery((previous) => ({
              ...previous,
              page: 1,
              keyword: submittedKeyword,
            }));
          }}
        >
          <div className="filter-field">
            <label htmlFor="activity-keyword">关键词</label>
            <Input
              id="activity-keyword"
              aria-label="搜索活动"
              placeholder="搜索活动标题或地点"
              value={keyword}
              maxLength={200}
              allowClear
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
          <div className="filter-field filter-select">
            <label htmlFor="activity-status">活动状态</label>
            <Select<ActivityFilter>
              id="activity-status"
              aria-label="活动状态"
              value={query.status}
              onChange={(status) =>
                setQuery((previous) => ({ ...previous, status, page: 1 }))
              }
              options={[
                { value: "ALL", label: "全部状态" },
                { value: "OPEN", label: "报名中" },
                { value: "FULL", label: "已满员" },
                { value: "STARTED", label: "已开始" },
                { value: "UPCOMING", label: "即将开始" },
              ]}
            />
          </div>
          <div className="filter-actions">
            <Button
              type="primary"
              htmlType="submit"
              icon={<SearchOutlined aria-hidden="true" />}
            >
              查询
            </Button>
            <Button
              onClick={() => {
                setKeyword("");
                setQuery((previous) => ({
                  ...previous,
                  page: 1,
                  keyword: "",
                  status: "ALL",
                }));
              }}
            >
              重置
            </Button>
          </div>
        </form>
        {resource.error ? (
          <ErrorState error={resource.error} retry={resource.retry} />
        ) : (
          <AdminActivityTable
            activities={resource.data?.items ?? []}
            loading={resource.loading}
            pagination={{
              current: query.page,
              pageSize: query.pageSize,
              total: resource.data?.total ?? 0,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50],
              showTotal: (total) => `共 ${total} 场活动`,
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
    </div>
  );
}
