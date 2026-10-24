package com.example.gather.api;

import jakarta.validation.constraints.*;
import java.math.BigDecimal;

public final class CheckInModels {
    private CheckInModels() {}

    public record LocationCheckInRequest(
        @NotNull(message = "请提供定位经度") @DecimalMin(value = "-180", message = "定位经度不正确")
        @DecimalMax(value = "180", message = "定位经度不正确") @Digits(integer = 3, fraction = 18, message = "定位经度精度不正确") BigDecimal longitude,
        @NotNull(message = "请提供定位纬度") @DecimalMin(value = "-90", message = "定位纬度不正确")
        @DecimalMax(value = "90", message = "定位纬度不正确") @Digits(integer = 2, fraction = 18, message = "定位纬度精度不正确") BigDecimal latitude,
        @NotNull(message = "请提供定位精度") @DecimalMin(value = "0", inclusive = false, message = "定位精度应大于 0 且不超过 100 米")
        @DecimalMax(value = "100", message = "定位精度应大于 0 且不超过 100 米") @Digits(integer = 3, fraction = 18, message = "定位精度不正确") BigDecimal accuracyMeters,
        @NotNull(message = "请刷新报名记录后重试") @PositiveOrZero(message = "签到版本不正确") Long expectedVersion) {}

    public record ConfirmCheckInRequest(@PositiveOrZero(message = "签到版本不正确") Long expectedVersion) {}

    public record CorrectCheckInRequest(
        @NotNull(message = "请选择签到状态") Boolean checkedIn,
        @NotBlank(message = "请填写更正原因") @Size(max = 500, message = "更正原因最多 500 字")
        @Pattern(regexp = "[^\\r\\n\\u000B\\u000C\\u0085\\u2028\\u2029]*", message = "更正原因必须为单行文本") String reason,
        @NotNull(message = "请刷新报名记录后重试") @PositiveOrZero(message = "签到版本不正确") Long expectedVersion) {}
}
