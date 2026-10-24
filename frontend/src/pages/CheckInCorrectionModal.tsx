import { useState } from "react";
import { Alert, Button, Input, Modal, Select } from "antd";
import { checkInCorrectionReasonError } from "../registrationCheckIn";
import type { AdminRegistration } from "../types";

export function CheckInCorrectionModal({ registration, busy, allowed, error, onCancel, onSubmit }: {
  registration: AdminRegistration;
  busy: boolean;
  allowed: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (checkedIn: boolean, reason: string) => void;
}) {
  const initial = !!registration.checkedInAt;
  const [checkedIn, setCheckedIn] = useState(!initial);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const valid = checkedIn !== initial && !checkInCorrectionReasonError(reason);
  return <Modal title="更正签到" open destroyOnHidden closable={!busy} maskClosable={!busy}
    onCancel={() => { if (!busy) onCancel(); }} footer={[
      <Button key="cancel" aria-label="取消" disabled={busy} onClick={onCancel}>取消</Button>,
      <Button key="submit" type="primary" loading={busy} disabled={busy || !allowed || !valid}
        onClick={() => {
          const problem = checkInCorrectionReasonError(reason);
          setReasonError(problem);
          if (!problem && checkedIn !== initial) onSubmit(checkedIn, reason.trim());
        }}>保存更正</Button>,
    ]}>
    <p>更正 <strong>{registration.displayName}</strong>（{registration.username}）的签到结果。</p>
    <p className="metadata">当前状态：{initial ? "已签到" : "未签到"}。更正会记录管理员、时间与原因，不改变报名、名额或候补。</p>
    <div className="filter-field">
      <label htmlFor="correction-checked-in">更正后的签到状态</label>
      <Select id="correction-checked-in" aria-label="更正后的签到状态" value={checkedIn ? "CHECKED_IN" : "NOT_CHECKED_IN"}
        disabled={busy} options={[{ value: "CHECKED_IN", label: "已签到（补签）" }, { value: "NOT_CHECKED_IN", label: "未签到（撤销）" }]}
        onChange={value => setCheckedIn(value === "CHECKED_IN")} />
    </div>
    <div className="filter-field">
      <label htmlFor="correction-reason">更正原因（必填）</label>
      <Input id="correction-reason" aria-label="更正原因" value={reason} maxLength={500} disabled={busy}
        placeholder="请填写单行原因，最多 500 字" status={reasonError ? "error" : undefined}
        aria-invalid={!!reasonError} aria-describedby={reasonError ? "correction-reason-error" : undefined}
        onChange={event => { setReason(event.target.value); setReasonError(checkInCorrectionReasonError(event.target.value)); }} />
    </div>
    {reasonError && <p id="correction-reason-error" role="alert">{reasonError}</p>}
    {checkedIn === initial && <p role="status">请选择与当前不同的签到状态。</p>}
    {error && <Alert type="error" showIcon title={error} />}
  </Modal>;
}
