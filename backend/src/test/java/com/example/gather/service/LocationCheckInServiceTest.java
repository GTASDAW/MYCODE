package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.CheckInModels.LocationCheckInRequest;
import com.example.gather.api.MyRegistrationModels.*;
import com.example.gather.domain.LocationCheckInPreflightRow;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.maps.LocationCheckInConfiguration;
import com.example.gather.maps.LocationCoordinateConverter;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.*;
import java.util.List;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class LocationCheckInServiceTest {
    private static final Instant NOW=Instant.parse("2050-01-01T00:00:00Z");
    private final RegistrationMapper registrations=mock(RegistrationMapper.class);
    private final LocationCoordinateConverter converter=mock(LocationCoordinateConverter.class);
    private final LocationCheckInWriter writer=mock(LocationCheckInWriter.class);
    private final LocationCheckInRequest request=new LocationCheckInRequest(new BigDecimal("1.0001"),new BigDecimal("2.0002"),BigDecimal.valueOf(33),0L);
    private final MyRegistrationView result=new MyRegistrationView(1,"ACTIVE",null,NOW,"SELF_LOCATION",1);

    @Test void standardEntryConvertsExactlyOnceAndCompatibilityPassesOnlyTheDeclaredGcj02Point(){
        when(registrations.findLocationCheckInPreflight(1,2)).thenReturn(row(false));
        var converted=new LocationCoordinateConverter.Point(BigDecimal.valueOf(3),BigDecimal.valueOf(4));
        when(converter.convert(request.longitude(),request.latitude())).thenReturn(converted);
        when(writer.checkIn(9,1,2,0,converted)).thenReturn(result);
        var service=service(true);
        assertThat(service.checkIn(1,2,request)).isSameAs(result);
        verify(converter).convert(request.longitude(),request.latitude());
        verify(writer).checkIn(9,1,2,0,converted);
        clearInvocations(converter,writer);
        var raw=new LocationCoordinateConverter.Point(request.longitude(),request.latitude());
        when(writer.checkIn(9,1,2,0,raw)).thenReturn(result);
        assertThat(service.checkInGcj02(1,2,request)).isSameAs(result);
        verifyNoInteractions(converter);
        verify(writer).checkIn(9,1,2,0,raw);
        verifyNoMoreInteractions(writer);
    }
    @Test void bothUnsignedPathsRequireConfigurationBeforeAnyConverterOrWriterCall(){
        when(registrations.findLocationCheckInPreflight(1,2)).thenReturn(row(false));
        var disabled=service(false);
        for(Runnable action:List.<Runnable>of(()->disabled.checkIn(1,2,request),()->disabled.checkInGcj02(1,2,request)))
            assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,error->{
                assertThat(error.status().value()).isEqualTo(503);assertThat(error.code()).isEqualTo("LOCATION_CHECK_IN_UNAVAILABLE");});
        verifyNoInteractions(converter,writer);
    }
    @Test void signedRepeatsKeepTheLockedWriterPathWhenConfigurationIsUnavailable(){
        when(registrations.findLocationCheckInPreflight(1,2)).thenReturn(row(true));
        when(writer.checkIn(9,1,2,0,null)).thenReturn(result);
        var disabled=service(false);
        assertThat(disabled.checkIn(1,2,request)).isSameAs(result);
        assertThat(disabled.checkInGcj02(1,2,request)).isSameAs(result);
        verifyNoInteractions(converter);verify(writer,times(2)).checkIn(9,1,2,0,null);
    }
    @Test void compatibilityStillValidatesAccuracyBeforeDatabaseAndDoesNotResolveAnotherEncoding(){
        var invalid=new LocationCheckInRequest(request.longitude(),request.latitude(),new BigDecimal("100.001"),0L);
        assertThatThrownBy(()->service(true).checkInGcj02(1,2,invalid)).isInstanceOfSatisfying(ApiException.class,
            error->assertThat(error.code()).isEqualTo("VALIDATION_ERROR"));
        verifyNoInteractions(registrations,converter,writer);
    }
    @Test void protocolCapabilityIsIndependentOfReadinessAndKeepsTheLegacyRecordConstructors(){
        var json=new ObjectMapper();
        var page=new MyRegistrationPageView(List.of(),0,1,10,new MyRegistrationSummary(0,0,0,0),false);
        var body=json.readTree(json.writeValueAsString(page));
        assertThat(body.size()).isEqualTo(7);
        assertThat(body.path("locationCheckInEnabled").asBoolean()).isFalse();
        assertThat(body.path("locationCheckInGcj02Supported").asBoolean()).isTrue();
        var requestBody=json.readTree(json.writeValueAsString(request));
        assertThat(requestBody.size()).isEqualTo(4);assertThat(requestBody.has("coordinateSystem")).isFalse();
    }
    private LocationCheckInService service(boolean enabled){
        return new LocationCheckInService(registrations,converter,writer,new LocationCheckInConfiguration(enabled?"offline_compat_key_123456":""));
    }
    private static LocationCheckInPreflightRow row(boolean signed){
        return new LocationCheckInPreflightRow(1,9,2,"ACTIVE",signed?LocalDateTime.ofInstant(NOW,ZoneOffset.UTC):null,0,
            null,LocalDateTime.ofInstant(NOW.plusSeconds(60),ZoneOffset.UTC),BigDecimal.ZERO,BigDecimal.ZERO);
    }
}
