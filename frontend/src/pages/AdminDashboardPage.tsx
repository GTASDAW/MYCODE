import { Button, Card, Statistic } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorState, PageHeading } from "../components";
import { useAuthenticatedResource } from "./useAuthenticatedResource";
import { AdminActivityTable } from "./AdminActivityTable";

export function AdminDashboardPage() {
  const { user } = useAuth();
  const overview = useAuthenticatedResource(api.adminOverview, [user?.id]);
  const upcoming = useAuthenticatedResource(
    (signal) =>
      api.adminActivities(
        { page: 1, pageSize: 5, keyword: "", status: "UPCOMING" },
        signal,
      ),
    [user?.id],
  );
  const indicators = [
    {
      key: "totalActivities" as const,
      title: "总活动",
      suffix: "场",
      hint: "已发布的全部活动",
    },
    {
      key: "upcomingActivities" as const,
      title: "即将开始",
      suffix: "场",
      hint: "尚未开始、未取消的活动",
    },
    {
      key: "cancelledActivities" as const,
      title: "已取消活动",
      suffix: "场",
      hint: "组织者已取消、保留历史的活动",
    },
    {
      key: "activeRegistrations" as const,
      title: "有效报名数",
      suffix: "人次",
      hint: "全部活动当前有效报名记录",
    },
    {
      key: "availableSeats" as const,
      title: "可报名名额",
      suffix: "个",
      hint: "尚未开始、未取消活动的剩余名额",
    },
    {
      key: "waitingRegistrations" as const,
      title: "候补报名数",
      suffix: "人次",
      hint: "全部活动当前候补记录",
    },
  ];
  return (
    <div className="page-container">
      <PageHeading
        title="概览"
        section="管理后台"
        description="查看活动与报名的当前情况，管理近期活动。"
        extra={
          <Link to="/admin/activities/new">
            <Button type="primary" icon={<PlusOutlined aria-hidden="true" />}>
              发布活动
            </Button>
          </Link>
        }
      />
      {overview.error ? (
        <ErrorState error={overview.error} retry={overview.retry} />
      ) : (
        <div className="overview-grid">
          {indicators.map((indicator) => (
            <Card
              key={indicator.key}
              className="stat-card"
              loading={overview.loading}
            >
              <div data-testid={`overview-${indicator.key}`}>
                <Statistic
                  title={indicator.title}
                  value={overview.data?.[indicator.key] ?? "—"}
                  suffix={indicator.suffix}
                />
              </div>
              <p className="stat-footnote">{indicator.hint}</p>
            </Card>
          ))}
        </div>
      )}
      <Card
        title="近期活动"
        extra={<Link to="/admin/activities">查看全部活动</Link>}
        className="table-card"
      >
        {upcoming.error ? (
          <ErrorState error={upcoming.error} retry={upcoming.retry} />
        ) : (
          <AdminActivityTable
            activities={upcoming.data?.items ?? []}
            loading={upcoming.loading}
            onChanged={() => {
              upcoming.retry();
              overview.retry();
            }}
            pagination={false}
          />
        )}
      </Card>
    </div>
  );
}
