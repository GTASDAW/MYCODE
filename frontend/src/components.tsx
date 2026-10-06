import type { ReactNode } from "react";
import { Alert, Breadcrumb, Button, Empty, Skeleton, Tag } from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CalendarOutlined,
  EnvironmentOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Link } from "react-router";
import { dateParts, formatDate, formatTime } from "./date";
import { errorMessage } from "./api";
import type { Activity } from "./types";

export function Logo() {
  return (
    <Link to="/activities" className="brand" aria-label="集会 Gather 首页">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="brand-word">
        集会 <span>Gather</span>
      </span>
    </Link>
  );
}

export function BackLink() {
  return (
    <Link className="back-link" to="/activities">
      <ArrowLeftOutlined aria-hidden="true" /> 返回全部活动
    </Link>
  );
}

export function PageHeading({
  title,
  description,
  section = "活动平台",
  extra,
}: {
  title: string;
  description?: string;
  section?: string;
  extra?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <Breadcrumb
        items={[
          { title: <Link to="/activities">首页</Link> },
          { title: section },
          { title },
        ]}
      />
      <div className="page-heading-row">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {extra && <div className="page-heading-extra">{extra}</div>}
      </div>
    </header>
  );
}

export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <Alert
        type="error"
        showIcon
        title="暂时无法完成操作"
        description={errorMessage(error)}
      />
      {retry && <Button onClick={retry}>重新加载</Button>}
    </div>
  );
}

export function LoadingState({ cards = false }: { cards?: boolean }) {
  return (
    <div
      aria-busy="true"
      aria-label="正在加载"
      className={cards ? "activity-grid" : "loading-panel"}
    >
      {Array.from({ length: cards ? 3 : 1 }, (_, i) => (
        <div className="skeleton-card" key={i}>
          <Skeleton active paragraph={{ rows: cards ? 5 : 4 }} />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <>
            <strong>{title}</strong>
            <p>{description}</p>
          </>
        }
      >
        {action}
      </Empty>
    </div>
  );
}

export function ActivityStatus({
  activity,
  personal = true,
}: {
  activity: Activity;
  personal?: boolean;
}) {
  if (activity.closed) return <Tag className="status-tag">已开始</Tag>;
  if (personal && activity.registrationStatus === "ACTIVE")
    return (
      <Tag className="status-tag" color="green">
        已报名
      </Tag>
    );
  if (personal && activity.registrationStatus === "WAITING")
    return (
      <Tag className="status-tag" color="orange">
        候补中
      </Tag>
    );
  if (activity.registeredCount >= activity.capacity)
    return (
      <Tag className="status-tag" color="orange">
        已满员
      </Tag>
    );
  return (
    <Tag className="status-tag" color="blue">
      报名中
    </Tag>
  );
}

export function DateBadge({
  startsAt,
  large = false,
}: {
  startsAt: string;
  large?: boolean;
}) {
  const parts = dateParts(startsAt);
  return (
    <div
      className={`date-badge ${large ? "date-badge-large" : ""}`}
      aria-label={formatDate(startsAt)}
    >
      <span>{Number(parts.month)} 月</span>
      <strong>{parts.day}</strong>
    </div>
  );
}

export function ActivityCard({ activity }: { activity: Activity }) {
  const remaining = Math.max(0, activity.capacity - activity.registeredCount);
  return (
    <article className="activity-card">
      <div className="activity-card-top">
        <DateBadge startsAt={activity.startsAt} />
        <ActivityStatus activity={activity} />
      </div>
      <h3>
        <Link to={`/activities/${activity.id}`}>{activity.title}</Link>
      </h3>
      <p className="card-description">{activity.description}</p>
      <div className="card-meta">
        <span>
          <CalendarOutlined aria-hidden="true" />
          {formatDate(activity.startsAt, false)} ·{" "}
          {formatTime(activity.startsAt)}
        </span>
        <span>
          <EnvironmentOutlined aria-hidden="true" />
          <span className="location-text">{activity.location}</span>
        </span>
      </div>
      <div className="card-bottom">
        <span>
          <TeamOutlined aria-hidden="true" />
          {activity.registeredCount} / {activity.capacity} 人
          {!activity.closed && remaining > 0 && (
            <small>余 {remaining} 席</small>
          )}
          {(activity.waitingCount ?? 0) > 0 && (
            <small>候补 {activity.waitingCount} 人</small>
          )}
        </span>
        <Link
          className="card-link"
          to={`/activities/${activity.id}`}
          aria-label={`查看${activity.title}的详情`}
        >
          查看详情 <ArrowRightOutlined aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}
