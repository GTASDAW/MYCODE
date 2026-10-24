package com.example.gather.maps;

import java.net.URI;

/** The only external boundary; contract tests replace this, never the trusted upstream allowlist. */
public interface AmapTransport {
    int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    Response get(URI uri) throws Exception;
    record Response(int status, String contentType, byte[] body) {}
}
