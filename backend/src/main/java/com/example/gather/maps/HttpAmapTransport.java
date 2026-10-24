package com.example.gather.maps;

import org.springframework.stereotype.Component;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

@Component
public final class HttpAmapTransport implements AmapTransport {
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
        .followRedirects(HttpClient.Redirect.NEVER).build();

    @Override public Response get(URI uri) throws Exception {
        // No browser headers, credentials, Cookie, body, Referer or redirect targets enter this request.
        var request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5))
            .header("Accept", "application/json, application/javascript").GET().build();
        var pending = client.sendAsync(request, info -> new LimitedBody());
        try {
            var response = pending.get(5, TimeUnit.SECONDS);
            return new Response(response.statusCode(), response.headers().firstValue("Content-Type").orElse(""), response.body());
        } finally {
            // Includes the response body in the five-second deadline and cancels a timed-out transfer.
            if (!pending.isDone()) pending.cancel(true);
        }
    }

    static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private Flow.Subscription subscription;
        @Override public CompletionStage<byte[]> getBody() { return result; }
        @Override public void onSubscribe(Flow.Subscription value) { subscription = value; value.request(1); }
        @Override public void onNext(List<ByteBuffer> buffers) {
            for (var buffer : buffers) {
                if ((long) bytes.size() + buffer.remaining() > MAX_RESPONSE_BYTES) {
                    subscription.cancel(); result.completeExceptionally(new IOException("Map response exceeds its size limit")); return;
                }
                byte[] chunk = new byte[buffer.remaining()]; buffer.get(chunk); bytes.writeBytes(chunk);
            }
            subscription.request(1);
        }
        @Override public void onError(Throwable error) { result.completeExceptionally(error); }
        @Override public void onComplete() { result.complete(bytes.toByteArray()); }
    }
}
