import { useState } from "react";
import { Avatar } from "antd";
import { UserOutlined } from "@ant-design/icons";
import { useAuth } from "./auth";
import { avatarInitial } from "./accountAvatar";

function AvatarImage({ source, displayName, size, testId }: { source: string | null; displayName: string; size: number; testId?: string }) {
  const [failed, setFailed] = useState(false);
  const initial = avatarInitial(displayName);
  return <Avatar size={size} className="account-avatar" data-testid={testId} icon={!initial ? <UserOutlined aria-hidden="true" /> : undefined}
    src={source && !failed ? <img src={source} alt="我的头像" onError={() => setFailed(true)} /> : undefined}>
    {initial || undefined}
  </Avatar>;
}

export function AccountAvatar({ size = 64, testId }: { size?: number; testId?: string }) {
  const { user, avatarSource } = useAuth();
  // Native image events own this local source instance only. A late failure
  // cannot hide an image belonging to a later upload or authentication.
  return <AvatarImage key={avatarSource ?? "default"} source={avatarSource} displayName={user?.displayName ?? ""} size={size} testId={testId} />;
}
