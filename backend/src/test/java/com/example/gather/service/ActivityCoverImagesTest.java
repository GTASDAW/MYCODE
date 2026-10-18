package com.example.gather.service;

import com.example.gather.api.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.zip.CRC32;
import static org.assertj.core.api.Assertions.*;

class ActivityCoverImagesTest {
    private final ActivityCoverImages images = new ActivityCoverImages();

    @Test void normalizesTransparencyAndDimensionsToDeterministicJpegWithoutSourceMetadata() throws Exception {
        byte[] source = png(2000, 1000);
        var first = images.prepare(file("封面.PNG", "image/png", source));
        var second = images.prepare(file("different-name.png", "image/png", source));
        assertThat(first.bytes()).isEqualTo(second.bytes());
        assertThat(first.hash()).isEqualTo(second.hash()).hasSize(64);
        assertThat(first.hash()).isEqualTo(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(first.bytes())));
        assertThat(first.bytes()).hasSizeLessThanOrEqualTo(ActivityCoverImages.MAX_BYTES);
        var result = ImageIO.read(new ByteArrayInputStream(first.bytes()));
        assertThat(result.getWidth()).isEqualTo(1600); assertThat(result.getHeight()).isEqualTo(800);
        assertThat(result.getColorModel().hasAlpha()).isFalse();
        assertThat(new Color(result.getRGB(0, 0))).isEqualTo(Color.WHITE);
        assertThat(first.bytes()[0]).isEqualTo((byte) 0xff); assertThat(first.bytes()[1]).isEqualTo((byte) 0xd8);
    }

    @Test void acceptsActualJpegAndRejectsEmptyFakeUnsupportedMismatchedAndDamagedImages() throws Exception {
        var rgb = new BufferedImage(12, 8, BufferedImage.TYPE_INT_RGB);
        var output = new ByteArrayOutputStream(); ImageIO.write(rgb, "JPEG", output);
        assertThat(images.prepare(file("cover.jpeg", "image/jpeg", output.toByteArray())).hash()).hasSize(64);
        for (var invalid : new MockMultipartFile[] {
            file("cover.png", "image/png", new byte[0]),
            file("cover.png", "image/png", "<svg onload='alert(1)'/>".getBytes()),
            file("cover.gif", "image/gif", "GIF89a".getBytes()),
            file("cover.svg", "image/svg+xml", png(2, 2)),
            file("cover.jpg", "image/jpeg", png(2, 2)),
            file("cover.png", "image/jpeg", png(2, 2)),
            file("cover.png", "application/octet-stream", png(2, 2)),
            file("cover.png", "image/png", Arrays.copyOf(png(2, 2), 40)),
            file("cover.jpg", "image/jpeg", Arrays.copyOf(output.toByteArray(), 40)),
        }) {
            assertThatThrownBy(() -> images.prepare(invalid)).isInstanceOfSatisfying(ApiException.class,
                error -> assertThat(error.status().value()).isEqualTo(400));
        }
    }

    @Test void rejectsOversizeAndPixelBombFromHeaderBeforeDecoding() throws Exception {
        assertThatThrownBy(() -> images.prepare(file("cover.png", "image/png", new byte[ActivityCoverImages.MAX_BYTES + 1])))
            .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.status().value()).isEqualTo(413));
        for (int[] dimensions : new int[][] {{4097, 1}, {1, 4097}, {4096, 4096}, {Integer.MAX_VALUE, Integer.MAX_VALUE}}) {
            byte[] header = png(1, 1);
            ByteBuffer.wrap(header).putInt(16, dimensions[0]).putInt(20, dimensions[1]);
            var crc = new CRC32(); crc.update(header, 12, 17); ByteBuffer.wrap(header).putInt(29, (int) crc.getValue());
            assertThatThrownBy(() -> images.prepare(file("cover.png", "image/png", header)))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.status().value()).isEqualTo(400));
        }
    }

    static MockMultipartFile file(String name, String type, byte[] bytes) { return new MockMultipartFile("file", name, type, bytes); }
    static byte[] png(int width, int height) throws Exception {
        var image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        var output = new ByteArrayOutputStream(); ImageIO.write(image, "PNG", output); image.flush(); return output.toByteArray();
    }
}
