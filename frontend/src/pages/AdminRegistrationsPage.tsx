import { useEffect, useState } from "react";
import { Button, Card, Descriptions, Select, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  ActivityStatus,
  ActivityCancellationNotice,
  ErrorState,
  LoadingState,
  PageHeading,
} from "../components";
import { formatDate, formatTime } from "../date";
import type {
  AdminRegistration,
  AdminRegistrationQuery,
  RegistrationFilter,
} from "../types";
import { useAuthenticatedResource } from "./useAuthenticatedResource";

const dateTime = (value: string) => `${formatDate(value)} ${formatTime(value)}`;
const columns: TableColumnsType<AdminRegistration> = [
  { title: "用户名", dataIndex: "username", key: "username", width: 160 },
  { title: "姓名", dataIndex: "displayName", key: "displayName", width: 160 },
  {
    title: "报名状态",
    dataIndex: "status",
    key: "status",
    width: 110,
    render: (value: string) => (
      <Tag
        color={
          value === "ACTIVE"
            ? "green"
            : value === "WAITING"
              ? "orange"
              : "default"
        }
      >
        {value === "ACTIVE"
          ? "已报名"
          : value === "WAITING"
            ? "候补中"
            : "已取消"}
      </Tag>
    ),
  },
  {
    title: "首次报名时间（北京时间）",
    dataIndex: "createdAt",
    key: "createdAt",
    width: 260,
    render: dateTime,
  },
  {
    title: "最近更新时间（北京时间）",
    dataIndex: "updatedAt",
    key: "updatedAt",
    width: 260,
    render: dateTime,
  },
];

export function AdminRegistrationsRoute() {
  const { id } = useParams();
  const { user } = useAuth();
  return <AdminRegistrationsPage key={`${id}:${user?.id}`} />;
}

function AdminRegistrationsPage() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const [query, setQuery] = useState<AdminRegistrationQuery>({
    page: 1,
    pageSize: 10,
    status: "ALL",
  });
  const resource = useAuthenticatedResource(
    (signal) => api.adminRegistrations(id, query, signal),
    [id, user?.id, query.page, query.pageSize, query.status],
  );
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
  return (
    <div className="page-container">
      <PageHeading
        title="报名名单"
        section="活动管理"
        description={activity ? activity.title : "查看活动参与者及报名状态。"}
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
          <span className="filter-note">
            取消后重新报名会更新原记录的状态和时间。
          </span>
        </div>
        {resource.error ? (
          <ErrorState error={resource.error} retry={resource.retry} />
        ) : (
          <Table<AdminRegistration>
            rowKey="id"
            columns={columns}
            dataSource={resource.data?.items ?? []}
            loading={resource.loading}
            scroll={{ x: 950 }}
            locale={{ emptyText: "暂无符合条件的报名记录" }}
            pagination={{
              current: query.page,
              pageSize: query.pageSize,
              total: resource.data?.total ?? 0,
              showSizeChanger: true,
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
    </div>
  );
}
