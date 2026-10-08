import { Button, Card, Descriptions, Empty, Statistic, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorState, LoadingState, PageHeading } from "../components";
import type { AdminMonitoring, RouteMetrics } from "../types";
import { useAuthenticatedResource } from "./useAuthenticatedResource";

const timestampFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function duration(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

const columns: TableColumnsType<RouteMetrics> = [
  {
    title: "方法",
    dataIndex: "method",
    width: 90,
    render: (method: string) => <Tag color="blue">{method}</Tag>,
  },
  { title: "接口路径模板", dataIndex: "route", width: 320 },
  {
    title: "状态码",
    dataIndex: "status",
    width: 100,
    render: (status: number) => (
      <Tag color={status >= 500 ? "red" : status >= 400 ? "orange" : "green"}>
        {status}
      </Tag>
    ),
  },
  { title: "累计请求数", dataIndex: "count", width: 130, align: "right" },
  {
    title: "累计平均耗时（ms）",
    dataIndex: "averageDurationMs",
    width: 170,
    align: "right",
    render: duration,
  },
  {
    title: "窗口 P95（ms）",
    dataIndex: "p95DurationMs",
    width: 150,
    align: "right",
    render: duration,
  },
  {
    title: "窗口最大耗时（ms）",
    dataIndex: "maxDurationMs",
    width: 170,
    align: "right",
    render: duration,
  },
];

function MonitoringSnapshot({ data }: { data: AdminMonitoring }) {
  const windowMinutes = data.latencyWindowSeconds / 60;
  return (
    <>
      <Card className="monitoring-snapshot" title="当前实例快照">
        <Descriptions
          column={{ xs: 1, sm: 2, md: 2, lg: 3 }}
          items={[
            {
              key: "instance",
              label: "实例编号",
              children: (
                <span data-testid="monitoring-instance">{data.instanceId}</span>
              ),
            },
            {
              key: "started",
              label: "进程启动时间",
              children: timestampFormatter.format(new Date(data.startedAt)),
            },
            {
              key: "sampled",
              label: "采样时间",
              children: timestampFormatter.format(new Date(data.sampledAt)),
            },
          ]}
        />
        <p className="metadata monitoring-note">
          统计仅来自当前实例，进程重启后重置。多实例模式下，刷新可能读取不同实例；
          这里不合并各实例数据。时间均为北京时间。
        </p>
      </Card>
      <div className="overview-grid monitoring-overview">
        <Card className="stat-card">
          <Statistic title="请求总数" value={data.totalRequests} suffix="次" />
          <p className="stat-footnote">当前实例启动以来的 API 请求</p>
        </Card>
        <Card className="stat-card">
          <Statistic
            title="平均耗时"
            value={data.averageDurationMs}
            precision={2}
            suffix="ms"
          />
          <p className="stat-footnote">当前实例启动以来的平均请求耗时</p>
        </Card>
        <Card className="stat-card">
          <Statistic
            title="5xx 错误率"
            value={data.serverErrorRate * 100}
            precision={2}
            suffix="%"
          />
          <p className="stat-footnote">累计 {data.serverErrors} 次服务端错误</p>
        </Card>
        <Card className="stat-card">
          <Statistic title="4xx 请求数" value={data.clientErrors} suffix="次" />
          <p className="stat-footnote">包括未登录、无权限和业务校验拒绝</p>
        </Card>
      </div>
      <div className="monitoring-detail-grid">
        <Card title="活动记录获取耗时" className="monitoring-detail-card">
          <p className="metadata monitoring-card-intro">
            查询与锁等待合计，不等同于数据库纯锁等待时间。
          </p>
          <Descriptions
            column={1}
            items={[
              {
                key: "count",
                label: "累计获取次数",
                children: data.registrationLock.count,
              },
              {
                key: "average",
                label: "累计平均耗时",
                children: `${duration(data.registrationLock.averageDurationMs)} ms`,
              },
              {
                key: "p95",
                label: "窗口 P95",
                children:
                  data.registrationLock.p95DurationMs === null
                    ? "—"
                    : `${duration(data.registrationLock.p95DurationMs)} ms`,
              },
              {
                key: "max",
                label: "窗口最大耗时",
                children:
                  data.registrationLock.maxDurationMs === null
                    ? "—"
                    : `${duration(data.registrationLock.maxDurationMs)} ms`,
              },
            ]}
          />
        </Card>
        <Card title="数据库连接池" className="monitoring-detail-card">
          <p className="metadata monitoring-card-intro">
            当前实例采样时的连接情况；不可用的指标显示为 —。
          </p>
          <Descriptions
            column={1}
            items={[
              { key: "active", label: "使用中", children: data.databasePool.active ?? "—" },
              { key: "idle", label: "空闲连接", children: data.databasePool.idle ?? "—" },
              { key: "pending", label: "等待连接", children: data.databasePool.pending ?? "—" },
              { key: "max", label: "最大连接数", children: data.databasePool.max ?? "—" },
            ]}
          />
        </Card>
      </div>
      <Card title="接口请求统计" className="table-card monitoring-routes">
        <p className="metadata monitoring-card-intro">
          请求数和平均耗时为进程启动以来的累计值。P95 是最近 {windowMinutes}{" "}
          分钟的近似分位数，最大耗时采用相同窗口；无窗口样本时显示 —。
          活动记录获取耗时采用相同统计窗口。
        </p>
        <Table<RouteMetrics>
          rowKey={(row) => `${row.method}:${row.route}:${row.status}`}
          columns={columns}
          dataSource={data.routes}
          scroll={{ x: 1130 }}
          pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty description="当前实例暂无已完成的接口请求" /> }}
        />
      </Card>
    </>
  );
}

export function AdminMonitoringPage() {
  const { user } = useAuth();
  const metrics = useAuthenticatedResource(api.adminMonitoring, [user?.id]);
  return (
    <div className="page-container monitoring-page">
      <PageHeading
        title="运行指标"
        section="管理后台"
        description="查看当前实例的请求耗时、错误情况和数据库连接状态。"
        extra={
          <Button
            icon={<ReloadOutlined aria-hidden="true" />}
            onClick={metrics.retry}
            loading={metrics.loading}
          >
            刷新指标
          </Button>
        }
      />
      {metrics.error ? (
        <ErrorState error={metrics.error} retry={metrics.retry} />
      ) : metrics.loading ? (
        <LoadingState />
      ) : metrics.data ? (
        <MonitoringSnapshot data={metrics.data} />
      ) : (
        <Empty description="暂无运行指标" />
      )}
    </div>
  );
}
