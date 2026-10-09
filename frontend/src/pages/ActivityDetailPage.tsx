import { useEffect, useRef, useState } from "react";
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Descriptions,
  Popconfirm,
  Progress,
  Space,
  Tag,
} from "antd";
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import {
  ActivityStatus,
  ActivityCancellationNotice,
  BackLink,
  ErrorState,
  LoadingState,
  PageHeading,
} from "../components";
import { formatDate, formatTime } from "../date";
import { useResource } from "../useResource";
import { activityClosed } from "../activityLifecycle";
import { ActivityManagementActions } from "./ActivityManagementActions";
export function ActivityDetailRoute() {
  const { id } = useParams();
  const { user } = useAuth();
  return <ActivityDetailPage key={`${id}:${user?.id ?? "guest"}`} />;
}

function ActivityDetailPage() {
  const { id = "" } = useParams();
  const auth = useAuth();
  const resource = useResource(
    (signal) => api.activity(id, signal),
    [id, auth.user?.id],
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const activity = resource.data;

  async function mutate(cancel: boolean) {
    if (!activity) return;
    const wasWaiting = activity.registrationStatus === "WAITING";
    setBusy(true);
    setActionError(null);
    try {
      const updated = await (cancel
        ? api.cancel(activity.id)
        : api.register(activity.id));
      if (!mounted.current) return;
      resource.setData(updated);
      message.success(
        cancel
          ? wasWaiting
            ? "已取消候补"
            : "已取消报名"
          : updated.registrationStatus === "WAITING"
            ? "已进入候补"
            : "报名成功",
      );
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 401) {
        auth.expire();
        navigate("/login", {
          state: {
            from: `/activities/${id}`,
            notice: "登录已过期，请重新登录后继续。",
          },
        });
      } else {
        setActionError(errorMessage(error));
        // Refresh a potentially stale capacity or deadline after a rejected operation.
        if (error instanceof ApiError && error.status === 409) {
          try {
            const updated = await api.activity(id);
            if (mounted.current) resource.setData(updated);
          } catch {
            /* Keep the original, visible action error. */
          }
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (resource.loading)
    return (
      <div className="page-container">
        <LoadingState />
      </div>
    );
  if (resource.error)
    return (
      <div className="page-container">
        <BackLink />
        <ErrorState error={resource.error} retry={resource.retry} />
      </div>
    );
  if (!activity) return null;
  const registered = activity.registrationStatus === "ACTIVE";
  const waiting = activity.registrationStatus === "WAITING";
  const cancelled = activity.registrationStatus === "CANCELLED";
  const remaining = Math.max(0, activity.capacity - activity.registeredCount);
  const closed = activityClosed(activity);

  return (
    <div className="page-container detail-page">
      <PageHeading
        title={activity.title}
        description="活动详情 · 时间均为北京时间"
        extra={
          auth.user?.role === "ADMIN" ? (
            <Space wrap>
              <ActivityManagementActions activity={activity} onChanged={resource.setData} disabled={busy} />
              <Link to={`/admin/activities/${activity.id}/registrations`}>
                <Button>报名名单</Button>
              </Link>
            </Space>
          ) : undefined
        }
      />
      <BackLink />
      <ActivityCancellationNotice activity={activity} />
      <div className="detail-layout">
        <Card
          title="活动信息"
          className="detail-content"
          extra={<ActivityStatus activity={activity} />}
        >
          <Descriptions
            column={1}
            items={[
              {
                key: "time",
                label: "活动时间",
                children: `${formatDate(activity.startsAt)} · ${formatTime(activity.startsAt)}`,
              },
              {
                key: "location",
                label: "活动地点",
                children: activity.location,
              },
              {
                key: "capacity",
                label: "报名名额",
                children: `${activity.capacity} 人（发布后固定）`,
              },
            ]}
          />
          <section className="detail-description">
            <h2>活动介绍</h2>
            <p>{activity.description}</p>
          </section>
          <Alert
            type="info"
            showIcon
            icon={<SafetyCertificateOutlined aria-hidden="true" />}
            title="报名须知"
            description="报名后可在「我的报名」查看记录。活动开始前可以取消，开始后将关闭报名与取消。组织者取消活动后，报名与候补关闭，历史记录保留。"
          />
        </Card>
        <Card title="活动报名" className="registration-panel">
          <h2>
            {activity.cancelled
              ? "活动已取消"
              : registered
                ? "你的名额已确认"
                : waiting
                  ? "你已进入候补"
                  : closed
                    ? "活动已经开始"
                    : remaining === 0
                      ? "本场名额已满"
                      : "报名参加活动"}
          </h2>
          <div className="registration-number">
            <strong>{activity.registeredCount}</strong>
            <span>/ {activity.capacity} 人已报名</span>
          </div>
          {(activity.waitingCount ?? 0) > 0 && (
            <p className="remaining-text">当前候补 {activity.waitingCount} 人</p>
          )}
          <Progress
            percent={Math.min(
              100,
              Math.round((activity.registeredCount / activity.capacity) * 100),
            )}
            showInfo={false}
          />
          <p className="remaining-text">
            {closed ? (
              "报名与取消已关闭"
            ) : remaining ? (
              <>
                还有 <strong>{remaining}</strong> 个名额
              </>
            ) : (
              "暂无可报名名额，可加入候补"
            )}
          </p>
          {actionError && (
            <Alert
              className="action-error"
              type="error"
              showIcon
              title={actionError}
            />
          )}
          {!activity.cancelled && (registered || waiting) && (
            <div className="registered-notice">
              <CheckCircleFilled aria-hidden="true" />
              <span>{registered ? "已成功报名" : "已进入候补"}</span>
              {closed && <Tag>活动已开始</Tag>}
            </div>
          )}
          {cancelled && !activity.cancelled && (
            <p className="cancelled-notice">
              你之前取消了报名，有空位时可以重新加入。
            </p>
          )}
          {closed ? (
            <Button block disabled>
              {activity.cancelled ? "活动已取消" : "活动已开始"}
            </Button>
          ) : auth.loading ? (
            <Button block loading>
              正在确认登录状态
            </Button>
          ) : !auth.user ? (
            <Link to="/login" state={{ from: `/activities/${id}` }}>
              <Button block type="primary">
                {remaining === 0 ? "登录后加入候补" : "登录后报名"}{" "}
                <ArrowRightOutlined aria-hidden="true" />
              </Button>
            </Link>
          ) : registered || waiting ? (
            <Popconfirm
              title={waiting ? "确认取消候补？" : "确认取消这场活动的报名？"}
              description={
                waiting
                  ? "取消后将退出候补队列。"
                  : "取消后名额将释放，重新报名需要还有空位。"
              }
              okText="确认取消"
              cancelText="保留名额"
              onConfirm={() => mutate(true)}
              disabled={busy}
            >
              <Button block loading={busy}>
                {waiting ? "取消候补" : "取消报名"}
              </Button>
            </Popconfirm>
          ) : (
            <Button
              type="primary"
              block
              loading={busy}
              onClick={() => void mutate(false)}
            >
              {remaining === 0
                ? "加入候补"
                : cancelled
                  ? "重新报名"
                  : "立即报名"}
            </Button>
          )}
          <div className="panel-footnote">
            <ClockCircleOutlined aria-hidden="true" />
            <span>{activity.cancelled ? "活动取消后不再接受报名" : "活动开始前均可取消"}</span>
          </div>
        </Card>
      </div>
    </div>
  );
}
