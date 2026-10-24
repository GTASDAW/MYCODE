package com.example.gather.service;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class LocationDistanceTest {
    @Test void zeroSymmetryAndKnownEquatorDistance() {
        assertThat(LocationDistance.meters(116,39,116,39)).isZero();
        assertThat(LocationDistance.meters(0,0,1,0)).isCloseTo(111_195.0802335, within(0.0001));
        assertThat(LocationDistance.meters(116,39,116.001,39.001)).isEqualTo(LocationDistance.meters(116.001,39.001,116,39));
    }
    @Test void radiusBoundaryIsIndependentOfAccuracyAndAntimeridianIsStable() {
        double longitude = Math.toDegrees(300 / 6_371_008.8);
        assertThat(LocationDistance.meters(0,0,longitude,0)).isCloseTo(300, within(1e-10));
        assertThat(LocationDistance.meters(0,0,longitude-0.000000001,0)).isLessThan(300);
        assertThat(LocationDistance.meters(0,0,longitude+0.000000001,0)).isGreaterThan(300);
        assertThat(LocationDistance.meters(179.999,0,-179.999,0)).isBetween(222.0,223.0);
        assertThat(LocationDistance.meters(0,90,180,-90)).isFinite();
    }
}
