package com.example.gather.security.ratelimit;

import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/** No DNS lookup, forwarded-header middleware, CIDR trust, or client-selected proxy chain. */
public final class ClientSource {
    public static final String HEADER = "X-Gather-Client-IP";
    private final Set<String> trustedProxies;

    public ClientSource(List<String> trustedProxies) {
        this.trustedProxies = trustedProxies.stream().map(ClientSource::canonicalIp).collect(Collectors.toUnmodifiableSet());
    }

    public String resolve(HttpServletRequest request) {
        String remote = canonicalIp(request.getRemoteAddr());
        if (remote == null) return "unknown";
        if (!trustedProxies.contains(remote)) return remote;
        var values = request.getHeaders(HEADER);
        if (values == null || !values.hasMoreElements()) return remote;
        String forwarded = canonicalIp(values.nextElement());
        // Malformed, duplicate or comma-separated headers cannot choose a new bucket.
        return forwarded != null && !values.hasMoreElements() ? forwarded : remote;
    }

    static String canonicalIp(String value) {
        if (value == null || value.isEmpty() || value.length() > 45) return null;
        byte[] address = value.contains(":") ? ipv6(value) : ipv4(value);
        if (address == null) return null;
        try { return InetAddress.getByAddress(address).getHostAddress(); }
        catch (UnknownHostException impossible) { throw new IllegalStateException("Invalid address length", impossible); }
    }

    private static byte[] ipv4(String value) {
        String[] parts = value.split("\\.", -1);
        if (parts.length != 4) return null;
        byte[] result = new byte[4];
        for (int index = 0; index < 4; index++) {
            String part = parts[index];
            if (!part.matches("0|[1-9][0-9]{0,2}")) return null;
            int number = Integer.parseInt(part);
            if (number > 255) return null;
            result[index] = (byte) number;
        }
        return result;
    }

    private static byte[] ipv6(String value) {
        if (!value.matches("[0-9A-Fa-f:.]+")) return null;
        int compressed = value.indexOf("::");
        if (compressed != value.lastIndexOf("::")) return null;
        String left = compressed < 0 ? value : value.substring(0, compressed);
        String right = compressed < 0 ? "" : value.substring(compressed + 2);
        List<Integer> before = words(left, compressed < 0);
        List<Integer> after = words(right, true);
        if (before == null || after == null) return null;
        int count = before.size() + after.size();
        if (compressed < 0 ? count != 8 : count >= 8) return null;
        byte[] result = new byte[16];
        int position = 0;
        for (int word : before) { result[position++] = (byte) (word >> 8); result[position++] = (byte) word; }
        position = 16 - after.size() * 2;
        for (int word : after) { result[position++] = (byte) (word >> 8); result[position++] = (byte) word; }
        return result;
    }

    private static List<Integer> words(String value, boolean mayEndWithIpv4) {
        List<Integer> result = new ArrayList<>();
        if (value.isEmpty()) return result;
        String[] parts = value.split(":", -1);
        for (int index = 0; index < parts.length; index++) {
            String part = parts[index];
            if (part.contains(".")) {
                if (!mayEndWithIpv4 || index != parts.length - 1) return null;
                byte[] bytes = ipv4(part);
                if (bytes == null) return null;
                result.add((bytes[0] & 255) << 8 | bytes[1] & 255);
                result.add((bytes[2] & 255) << 8 | bytes[3] & 255);
            } else {
                if (!part.matches("[0-9A-Fa-f]{1,4}")) return null;
                result.add(Integer.parseInt(part, 16));
            }
        }
        return result;
    }
}
