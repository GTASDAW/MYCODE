import { Alert, Button, Empty, Skeleton, Tag } from "antd";
import {
  ArrowRightOutlined,
  CalendarOutlined,
  EnvironmentOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Link } from "react-router";
import { dateParts, formatDate, formatTime } from "./date";
import { errorMessage } from "./api";
import type { Activity } from "./types";

export function Logo({ light = false }: { light?: boolean }) {
  return (
    <Link
      to="/activities"
      className={`brand ${light ? "brand-light" : ""}`}
      aria-label="集会 Gather 首页"
    >
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
  action?: React.ReactNode;
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

export function ActivityStatus({ activity }: { activity: Activity }) {
  if (activity.closed)
    return (
      <Tag className="status-tag" color="default">
        已开始
      </Tag>
    );
  if (activity.registrationStatus === "ACTIVE")
    return (
      <Tag className="status-tag" color="green">
        已报名
      </Tag>
    );
  if (activity.registeredCount >= activity.capacity)
    return (
      <Tag className="status-tag" color="orange">
        已满员
      </Tag>
    );
  return (
    <Tag className="status-tag" color="purple">
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

export function ActivityCard({
  activity,
  index,
}: {
  activity: Activity;
  index: number;
}) {
  const remaining = Math.max(0, activity.capacity - activity.registeredCount);
  const ratio = Math.min(
    100,
    (activity.registeredCount / activity.capacity) * 100,
  );
  return (
    <article
      className="activity-card"
      style={{ animationDelay: `${Math.min(index, 5) * 60}ms` }}
    >
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
      <div
        className="seat-progress"
        aria-label={`已报名 ${activity.registeredCount} 人，共 ${activity.capacity} 个名额`}
      >
        <span style={{ width: `${ratio}%` }} />
      </div>
      <div className="card-bottom">
        <span>
          <TeamOutlined aria-hidden="true" />
          <strong>{activity.registeredCount}</strong> / {activity.capacity} 人
          {!activity.closed && remaining > 0 && (
            <small>余 {remaining} 席</small>
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
