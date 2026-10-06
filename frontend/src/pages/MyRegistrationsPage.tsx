import { Button, Card, Tag } from "antd";
import { CalendarOutlined, EnvironmentOutlined } from "@ant-design/icons";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  DateBadge,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
} from "../components";
import { formatDate, formatTime } from "../date";
import { useAuthenticatedResource } from "./useAuthenticatedResource";

export function MyRegistrationsPage() {
  const { user } = useAuth();
  const resource = useAuthenticatedResource(api.registrations, [user?.id]);
  const records = resource.data ?? [];
  const active = records.filter((row) => row.status === "ACTIVE").length;
  const waiting = records.filter((row) => row.status === "WAITING").length;
  return (
    <div className="page-container">
      <PageHeading
        title="我的报名"
        description="查看报名记录，或打开活动详情取消、重新报名。"
      />
      {resource.loading ? (
        <LoadingState />
      ) : resource.error ? (
        <ErrorState error={resource.error} retry={resource.retry} />
      ) : records.length === 0 ? (
        <EmptyState
          title="还没有报名记录"
          description="选择一场感兴趣的活动，报名后可以在这里查看。"
          action={
            <Link to="/activities">
              <Button type="primary">去发现活动</Button>
            </Link>
          }
        />
      ) : (
        <Card
          title={`已报名 ${active} 场活动${waiting ? ` · 候补 ${waiting} 场` : ""}`}
          extra={<span className="metadata">共 {records.length} 条记录</span>}
        >
          <div className="registration-list">
            {records.map(({ id, status, activity }) => (
              <article className="registration-row" key={id}>
                <DateBadge startsAt={activity.startsAt} />
                <div className="registration-row-main">
                  <h2>
                    <Link to={`/activities/${activity.id}`}>
                      {activity.title}
                    </Link>
                  </h2>
                  <p>
                    <CalendarOutlined aria-hidden="true" />
                    {formatDate(activity.startsAt)} ·{" "}
                    {formatTime(activity.startsAt)}
                  </p>
                  <p>
                    <EnvironmentOutlined aria-hidden="true" />
                    {activity.location}
                  </p>
                </div>
                <div className="registration-row-actions">
                  <Tag
                    color={
                      status === "ACTIVE"
                        ? "green"
                        : status === "WAITING"
                          ? "orange"
                          : "default"
                    }
                  >
                    {status === "ACTIVE"
                      ? "已报名"
                      : status === "WAITING"
                        ? "候补中"
                        : "已取消"}
                  </Tag>
                  {activity.closed && (
                    <span className="metadata">活动已开始</span>
                  )}
                  <Link to={`/activities/${activity.id}`}>查看活动</Link>
                </div>
              </article>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
