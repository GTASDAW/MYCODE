import { Link } from "react-router";
import { useAuth } from "../auth";
import { activityCopyPath } from "../activityCopy";

export function ActivityCopyLink({ activityId }: { activityId: number }) {
  const { user } = useAuth();
  return user?.role === "ADMIN" ? <Link to={activityCopyPath(activityId)}>复制活动</Link> : null;
}
