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
  ReloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import { readAccountResource } from "../authRequestGuard";
import {
  ActivityStatus,
  ActivityCancellationNotice,
  BackLink,
  ErrorState,
  LoadingState,
  PageHeading,
} from "../components";
import { formatActivityEnd, formatDate, formatRegistrationDeadline, formatTime } from "../date";
import { useResource } from "../useResource";
import { activityClosed, activityPhase, activityPhaseLabels, activityRegistrationClosed } from "../activityLifecycle";
import { useActivityClock } from "../useActivityClock";
import { ActivityManagementActions } from "./ActivityManagementActions";
import { safeActivityDetailReturn } from "../activityDetailNavigation";
import { activityCategoryLabel } from "../activityCategory";
import { FavoriteButton } from "./FavoriteButton";
import { CalendarDownloadButton } from "./CalendarDownloadButton";
import { ActivityCover } from "../ActivityCoverImage";
import { ActivityCopyLink } from "./ActivityCopyLink";
import { WaitingPositionNotice } from "../components/WaitingPositionNotice";
export function ActivityDetailRoute() {
  const { id } = useParams();
  const auth = useAuth();
  const account = auth.captureAccountRequest();
  return <ActivityDetailPage key={`${id}:${account ? `${account.userId}:${account.generation}` : "guest"}`} />;
}

function ActivityDetailPage() {
  const { id = "" } = useParams();
  const auth = useAuth();
  const location = useLocation();
  const sourceList = new URLSearchParams(location.search).get("from");
  const returnPath = safeActivityDetailReturn(sourceList, auth.user?.role === "ADMIN" ? Number(id) : undefined);
  const returnLabel = returnPath.split("?")[0] === `/admin/activities/${Number(id)}/registrations`
    ? "返回报名名单" : returnPath.split("?")[0] === "/my-registrations"
    ? "返回我的报名" : returnPath.split("?")[0] === "/my-favorites" ? "返回我的收藏"
      : sourceList === null ? "返回全部活动" : "返回活动列表";
  const detailPath = `${location.pathname}${location.search}`;
  const resource = useResource(
    (signal) => {
      const account = auth.captureAccountRequest();
      if (!account) return api.activity(id, signal);
      return readAccountResource(
        (requestSignal) => api.activity(id, requestSignal), signal,
        () => auth.isCurrentAccountRequest(account),
        (error) => {
          if (error instanceof ApiError && error.status === 401) auth.expire();
        },
      );
    },
    [id, auth.user?.id],
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useRef(true);
  const submission = useRef<AbortController | null>(null);
  const currentDetail = useRef(detailPath);
  currentDetail.current = detailPath;
  useEffect(() => {
    mounted.current = true;
    setBusy(false);
    setActionError(null);
    return () => {
      mounted.current = false;
      submission.current?.abort();
      submission.current = null;
    };
  }, [detailPath]);
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const activity = resource.data;
  const now = useActivityClock([activity ?? undefined]);

  async function mutate(cancel: boolean) {
    if (!activity || submission.current || activityClosed(activity) || !cancel && activityRegistrationClosed(activity)) return;
    const account = auth.captureAccountRequest();
    if (!account) return;
    const controller = new AbortController();
    submission.current = controller;
    const startedDetail = detailPath;
    const current = () => mounted.current && !controller.signal.aborted &&
      currentDetail.current === startedDetail && auth.isCurrentAccountRequest(account);
    const wasWaiting = activity.registrationStatus === "WAITING";
    setBusy(true);
    setActionError(null);
    try {
      const updated = await (cancel
        ? api.cancel(activity.id, controller.signal)
        : api.register(activity.id, controller.signal));
      if (!current()) return;
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
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) {
        auth.expire();
        navigate("/login", {
          state: {
            from: detailPath,
            notice: "登录已过期，请重新登录后继续。",
          },
        });
      } else {
        setActionError(errorMessage(error));
        // Refresh a potentially stale capacity or deadline after a rejected operation.
        if (error instanceof ApiError && error.status === 409) {
          try {
            const updated = await api.activity(id, controller.signal);
            if (current()) resource.setData(updated);
          } catch {
            /* Keep the original, visible action error. */
          }
        }
      }
    } finally {
      if (submission.current === controller) {
        submission.current = null;
        if (current()) setBusy(false);
      }
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
        <BackLink to={returnPath} label={returnLabel} />
        <ErrorState error={resource.error} retry={resource.retry} />
      </div>
    );
  if (!activity) return null;
  const registered = activity.registrationStatus === "ACTIVE";
  const waiting = activity.registrationStatus === "WAITING";
  const cancelled = activity.registrationStatus === "CANCELLED";
  const remaining = Math.max(0, activity.capacity - activity.registeredCount);
  const closed = activityClosed(activity);
  const registrationClosed = activityRegistrationClosed(activity);
  const phaseLabel = activityPhaseLabels[activityPhase(activity)];

  return (
    <div className="page-container detail-page">
      <PageHeading
        title={activity.title}
        description="活动详情 · 时间均为北京时间"
        extra={
            <Space wrap>
              <Button aria-label="刷新活动信息" icon={<ReloadOutlined aria-hidden="true" />} loading={resource.loading}
                disabled={busy} onClick={() => { if (!submission.current) resource.retry(); }}>刷新活动</Button>
              <FavoriteButton activityId={activity.id} detailPath={detailPath} />
              <CalendarDownloadButton activityId={activity.id} cancelled={activity.cancelled} detailPath={detailPath} refresh={resource.retry} />
              {auth.user?.role === "ADMIN" && <>
              <ActivityCopyLink activityId={activity.id} />
              <ActivityManagementActions activity={activity} onChanged={resource.setData} disabled={busy} />
              <Link to={`/admin/activities/${activity.id}/registrations`}>
                <Button>报名名单</Button>
              </Link>
              </>}
            </Space>
        }
      />
      <BackLink to={returnPath} label={returnLabel} />
      <ActivityCancellationNotice activity={activity} />
      <div className="detail-layout">
        <Card
          title="活动信息"
          className="detail-content"
          extra={<ActivityStatus activity={activity} />}
        >
          <ActivityCover id={activity.id} url={activity.coverUrl} title={activity.title} />
          <Descriptions
            column={1}
            items={[
              { key: "category", label: "活动分类", children: <span data-testid={`activity-category-${activity.id}`}>{activityCategoryLabel(activity.category)}</span> },
              {
                key: "time",
                label: "开始时间",
                children: `${formatDate(activity.startsAt)} · ${formatTime(activity.startsAt)}`,
              },
              { key: "end-time", label: "结束时间", children: formatActivityEnd(activity.endsAt) },
              { key: "registration-deadline", label: "报名截止", children: formatRegistrationDeadline(activity.registrationDeadline) },
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
          <p className="metadata">{!activity.endsAt && "活动未提供结束时间，可在个人日历中自行设置；"}添加日历不代表报名成功。日历文件为下载时快照，后续修改或取消不会自动同步。</p>
          <Alert
            type="info"
            showIcon
            icon={<SafetyCertificateOutlined aria-hidden="true" />}
            title="报名须知"
            description="报名后可在「我的报名」查看记录。报名截止后不能报名或加入候补，已报名和候补仍可在活动开始前取消。组织者取消活动后，报名与候补关闭，历史记录保留。"
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
                    ? `活动${phaseLabel}`
                    : registrationClosed
                      ? "报名已截止"
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
          <WaitingPositionNotice activity={activity} now={now} />
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
            ) : registrationClosed ? (
              "报名已截止，已报名和候补仍可在开始前取消"
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
              {closed && <Tag>{phaseLabel}</Tag>}
            </div>
          )}
          {cancelled && !activity.cancelled && (
            <p className="cancelled-notice">
              {registrationClosed ? "你之前取消了报名；本场报名已截止，不能重新报名。" : "你之前取消了报名，有空位时可以重新加入。"}
            </p>
          )}
          {closed ? (
            <Button block disabled>
              {phaseLabel}
            </Button>
          ) : auth.loading ? (
            <Button block loading>
              正在确认登录状态
            </Button>
          ) : registrationClosed && (!auth.user || !registered && !waiting) ? (
            <Button block disabled>报名已截止</Button>
          ) : !auth.user ? (
            <Link to="/login" state={{ from: detailPath }}>
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
                  ? registrationClosed ? "取消后将退出候补队列；报名已截止，不能重新加入。" : "取消后将退出候补队列。"
                  : registrationClosed ? "取消后名额将释放；报名已截止，不能重新报名。" : "取消后名额将释放，重新报名需要还有空位。"
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
