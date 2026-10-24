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
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.zip.CRC32;
import static org.assertj.core.api.Assertions.*;

class AvatarImagesTest {
    private final AvatarImages images = new AvatarImages();

    @Test void normalizesTransparentPngToDeterministicWhite256PixelJpegAndHashesOnlyOutput() throws Exception {
        byte[] source = png(400, 200);
        var first = images.prepare(file("头像.PNG", "image/png", source));
        var second = images.prepare(file("renamed.png", "image/png", source));
        assertThat(first.bytes()).isEqualTo(second.bytes()).hasSizeLessThanOrEqualTo(AvatarImages.MAX_BYTES);
        assertThat(first.hash()).isEqualTo(second.hash()).matches("[0-9a-f]{64}");
        assertThat(first.hash()).isEqualTo(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(first.bytes())));
        var result = ImageIO.read(new ByteArrayInputStream(first.bytes()));
        assertThat(result.getWidth()).isEqualTo(256); assertThat(result.getHeight()).isEqualTo(256);
        assertThat(result.getColorModel().hasAlpha()).isFalse();
        assertThat(new Color(result.getRGB(0, 0))).isEqualTo(Color.WHITE);
        assertThat(first.bytes()[0]).isEqualTo((byte) 0xff); assertThat(first.bytes()[1]).isEqualTo((byte) 0xd8);
    }

    @Test void cropsTheCenterSquareOfLandscapeAndPortraitInsteadOfStretchingEdges() throws Exception {
        for (boolean landscape : new boolean[] {true, false}) {
            var image = new BufferedImage(landscape ? 600 : 200, landscape ? 200 : 600, BufferedImage.TYPE_INT_RGB);
            var graphics = image.createGraphics();
            graphics.setColor(Color.RED); graphics.fillRect(0, 0, image.getWidth(), image.getHeight());
            graphics.setColor(Color.BLUE); graphics.fillRect(landscape ? 200 : 0, landscape ? 0 : 200, 200, 200);
            graphics.dispose();
            var output = new ByteArrayOutputStream(); ImageIO.write(image, "PNG", output); image.flush();
            var result = ImageIO.read(new ByteArrayInputStream(images.prepare(file("center.png", "image/png", output.toByteArray())).bytes()));
            for (int[] point : new int[][] {{16, 16}, {128, 128}, {240, 240}}) {
                var color = new Color(result.getRGB(point[0], point[1]));
                assertThat(color.getBlue()).isGreaterThan(245); assertThat(color.getRed()).isLessThan(10);
            }
        }
    }

    @Test void upscalesSmallJpegAndDropsEmbeddedCommentMetadata() throws Exception {
        var image = new BufferedImage(12, 8, BufferedImage.TYPE_INT_RGB);
        var output = new ByteArrayOutputStream(); ImageIO.write(image, "JPEG", output); image.flush();
        byte[] original = output.toByteArray(), comment = "avatar-private-metadata".getBytes(StandardCharsets.US_ASCII);
        var marked = new ByteArrayOutputStream(); marked.write(original, 0, 2);
        marked.write(new byte[] {(byte) 0xff, (byte) 0xfe, 0, (byte) (comment.length + 2)});
        marked.write(comment); marked.write(original, 2, original.length - 2);
        var prepared = images.prepare(file("small.jpeg", "image/jpeg", marked.toByteArray()));
        var result = ImageIO.read(new ByteArrayInputStream(prepared.bytes()));
        assertThat(result.getWidth()).isEqualTo(256); assertThat(result.getHeight()).isEqualTo(256);
        assertThat(new String(prepared.bytes(), StandardCharsets.ISO_8859_1)).doesNotContain("avatar-private-metadata");
        assertThat(prepared.bytes()).isEqualTo(images.prepare(file("small.jpg", "image/jpeg", original)).bytes());
    }

    @Test void rejectsEmptyFakeUnsupportedMismatchedAndTruncatedImages() throws Exception {
        var rgb = new BufferedImage(12, 8, BufferedImage.TYPE_INT_RGB);
        var output = new ByteArrayOutputStream(); ImageIO.write(rgb, "JPEG", output); rgb.flush();
        for (var invalid : new MockMultipartFile[] {
            file("avatar.png", "image/png", new byte[0]),
            file("avatar.png", "image/png", "<svg onload='alert(1)'/>".getBytes(StandardCharsets.UTF_8)),
            file("avatar.gif", "image/gif", "GIF89a".getBytes(StandardCharsets.US_ASCII)),
            file("avatar.webp", "image/webp", png(2, 2)),
            file("avatar.svg", "image/svg+xml", png(2, 2)),
            file("avatar.jpg", "image/jpeg", png(2, 2)),
            file("avatar.png", "image/jpeg", png(2, 2)),
            file("avatar", "image/png", png(2, 2)),
            file("avatar.png", "application/octet-stream", png(2, 2)),
            file("avatar.png", "image/png", Arrays.copyOf(png(2, 2), 40)),
            file("avatar.jpg", "image/jpeg", Arrays.copyOf(output.toByteArray(), 40)),
        }) {
            assertThatThrownBy(() -> images.prepare(invalid)).isInstanceOfSatisfying(ApiException.class, error -> {
                assertThat(error.status().value()).isEqualTo(400); assertThat(error.code()).isEqualTo("INVALID_AVATAR");
            });
        }
    }

    @Test void rejectsOversizeAndPixelBombFromHeadersBeforeAllocatingDecodedImage() throws Exception {
        assertThatThrownBy(() -> images.prepare(file("avatar.png", "image/png", new byte[AvatarImages.MAX_BYTES + 1])))
            .isInstanceOfSatisfying(ApiException.class, error -> {
                assertThat(error.status().value()).isEqualTo(413); assertThat(error.code()).isEqualTo("UPLOAD_TOO_LARGE");
            });
        for (int[] dimensions : new int[][] {{4097, 1}, {1, 4097}, {4096, 4096}, {Integer.MAX_VALUE, Integer.MAX_VALUE}}) {
            assertThatThrownBy(() -> images.prepare(file("avatar.png", "image/png", pngHeader(dimensions[0], dimensions[1]))))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.status().value()).isEqualTo(400));
        }
    }

    static byte[] pngHeader(int width, int height) throws Exception {
        byte[] header = png(1, 1);
        ByteBuffer.wrap(header).putInt(16, width).putInt(20, height);
        var crc = new CRC32(); crc.update(header, 12, 17); ByteBuffer.wrap(header).putInt(29, (int) crc.getValue());
        return header;
    }
    static MockMultipartFile file(String name, String type, byte[] bytes) { return new MockMultipartFile("file", name, type, bytes); }
    static byte[] png(int width, int height) throws Exception {
        var image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        var output = new ByteArrayOutputStream(); ImageIO.write(image, "PNG", output); image.flush(); return output.toByteArray();
    }
}
