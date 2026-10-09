import { Button, Card, Statistic } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { Link } from "react-router";
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

export function ActivitiesPage() {
  const { user } = useAuth();
  const resource = useResource(api.activities, [user?.id]);
  const activities = resource.data ?? [];
  const upcoming = activities.filter((activity) => !activity.cancelled && !activity.closed);
  const available = upcoming.reduce(
    (sum, activity) =>
      sum + Math.max(0, activity.capacity - activity.registeredCount),
    0,
  );
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
      <div className="public-overview">
        <Card>
          <Statistic
            title="即将开始的活动"
            value={resource.loading || resource.error ? "—" : upcoming.length}
            suffix="场"
          />
        </Card>
        <Card>
          <Statistic
            title="可报名名额"
            value={resource.loading || resource.error ? "—" : available}
            suffix="个"
          />
        </Card>
      </div>
      <section className="activities-section" id="activity-list">
        <div className="section-heading">
          <h2>全部活动</h2>
          {!resource.loading && !resource.error && (
            <span className="metadata">共 {activities.length} 场活动</span>
          )}
        </div>
        {resource.loading ? (
          <LoadingState cards />
        ) : resource.error ? (
          <ErrorState error={resource.error} retry={resource.retry} />
        ) : activities.length === 0 ? (
          <EmptyState
            title="还没有发布的活动"
            description="活动发布后会显示在这里。"
          />
        ) : (
          <div className="activity-grid">
            {activities.map((activity) => (
              <ActivityCard key={activity.id} activity={activity} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
