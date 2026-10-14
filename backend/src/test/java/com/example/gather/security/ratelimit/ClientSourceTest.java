package com.example.gather.security.ratelimit;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import java.util.List;
import static org.assertj.core.api.Assertions.assertThat;

class ClientSourceTest {
    @Test
    void noProxyTrustMeansEveryForwardedHeaderIsIgnored() {
        var source = new ClientSource(List.of());
        var request = request("192.0.2.1");
        request.addHeader("X-Forwarded-For", "198.51.100.2");
        request.addHeader("Forwarded", "for=198.51.100.3");
        request.addHeader(ClientSource.HEADER, "198.51.100.4");
        assertThat(source.resolve(request)).isEqualTo("192.0.2.1");
    }

    @Test
    void onlyExactTrustedPeerMaySupplyOneDedicatedLiteralAddress() {
        var source = new ClientSource(List.of("2001:DB8::1", "127.0.0.1"));
        var request = request("2001:db8:0:0:0:0:0:1");
        request.addHeader(ClientSource.HEADER, "2001:DB8::2");
        assertThat(source.resolve(request)).isEqualTo("2001:db8:0:0:0:0:0:2");
        var untrusted = request("127.0.0.2");
        untrusted.addHeader(ClientSource.HEADER, "198.51.100.1");
        assertThat(source.resolve(untrusted)).isEqualTo("127.0.0.2");
        var duplicate = request("127.0.0.1");
        duplicate.addHeader(ClientSource.HEADER, "198.51.100.1");
        duplicate.addHeader(ClientSource.HEADER, "198.51.100.2");
        assertThat(source.resolve(duplicate)).isEqualTo("127.0.0.1");
    }

    @Test
    void maliciousNonLiteralAndAmbiguousAddressesFallbackWithoutDnsLookup() {
        var source = new ClientSource(List.of("127.0.0.1"));
        for (String value : List.of("localhost", "example.com", "127.1", "0177.0.0.1", "256.0.0.1", "127.0.0.1:80",
                "127.0.0.1,198.51.100.1", " 127.0.0.1", "[::1]", "fe80::1%eth0", "1.2.3.4::", "::1::2", ":::", "1:2:3:4:5:6:7:8:9")) {
            var request = request("127.0.0.1");
            request.addHeader(ClientSource.HEADER, value);
            assertThat(source.resolve(request)).as(value).isEqualTo("127.0.0.1");
        }
    }

    @Test
    void ipv4MappedIpv6AndExpandedIpv6HaveOneCanonicalIdentity() {
        assertThat(ClientSource.canonicalIp("::ffff:192.0.2.1")).isEqualTo("192.0.2.1");
        assertThat(ClientSource.canonicalIp("::FFFF:c000:201")).isEqualTo("192.0.2.1");
        assertThat(ClientSource.canonicalIp("2001:DB8::a")).isEqualTo(ClientSource.canonicalIp("2001:db8:0:0:0:0:0:a"));
        assertThat(ClientSource.canonicalIp("::")).isEqualTo("0:0:0:0:0:0:0:0");
    }

    private static MockHttpServletRequest request(String remote) {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr(remote);
        return request;
    }
}
