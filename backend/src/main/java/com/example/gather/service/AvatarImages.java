package com.example.gather.service;

import com.example.gather.api.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.MemoryCacheImageInputStream;
import java.awt.Color;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;

/** Fully decode and normalize an untrusted avatar before opening the write transaction. */
@Component
public class AvatarImages {
    public static final int MAX_BYTES = 2 * 1024 * 1024;
    public record Prepared(byte[] bytes, String hash) {}

    public Prepared prepare(MultipartFile file) {
        if (file.getSize() > MAX_BYTES) throw tooLarge();
        if (file.isEmpty()) throw invalid();
        String name = file.getOriginalFilename();
        String extension = name == null || !name.contains(".") ? "" : name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        String expected = switch (extension) {
            case "jpg", "jpeg" -> "JPEG";
            case "png" -> "PNG";
            default -> throw invalid();
        };
        if (!(expected.equals("JPEG") ? "image/jpeg" : "image/png").equals(file.getContentType())) throw invalid();
        try {
            byte[] source = file.getBytes();
            if (source.length > MAX_BYTES) throw tooLarge();
            try (var input = new MemoryCacheImageInputStream(new ByteArrayInputStream(source))) {
                var readers = ImageIO.getImageReaders(input);
                if (!readers.hasNext()) throw invalid();
                ImageReader reader = readers.next();
                try {
                    reader.addIIOReadWarningListener((sourceReader, warning) -> { throw invalid(); });
                    if (!expected.equals(reader.getFormatName().toUpperCase(Locale.ROOT))) throw invalid();
                    reader.setInput(input, true, true);
                    int width = reader.getWidth(0), height = reader.getHeight(0);
                    if (width < 1 || height < 1 || width > 4096 || height > 4096 || (long) width * height > 16_000_000) {
                        throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_AVATAR", "图片宽高最多 4096 像素，总像素最多 1600 万");
                    }
                    BufferedImage decoded = reader.read(0);
                    if (decoded == null) throw invalid();
                    var normalized = new BufferedImage(256, 256, BufferedImage.TYPE_INT_RGB);
                    var graphics = normalized.createGraphics();
                    try {
                        graphics.setColor(Color.WHITE);
                        graphics.fillRect(0, 0, 256, 256);
                        graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                        int side = Math.min(width, height), left = (width - side) / 2, top = (height - side) / 2;
                        graphics.drawImage(decoded, 0, 0, 256, 256, left, top, left + side, top + side, null);
                    } finally { graphics.dispose(); decoded.flush(); }
                    var output = new ByteArrayOutputStream();
                    try {
                        if (!ImageIO.write(normalized, "JPEG", output)) throw invalid();
                    } finally { normalized.flush(); }
                    byte[] image = output.toByteArray();
                    if (image.length > MAX_BYTES) throw tooLarge();
                    return new Prepared(image, HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(image)));
                } finally { reader.dispose(); }
            }
        } catch (ApiException exception) {
            throw exception;
        } catch (IOException | RuntimeException exception) {
            throw invalid();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable");
        }
    }

    private static ApiException invalid() {
        return new ApiException(HttpStatus.BAD_REQUEST, "INVALID_AVATAR", "请选择有效的 PNG 或 JPEG 图片，文件扩展名和类型须一致");
    }

    private static ApiException tooLarge() {
        return new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "UPLOAD_TOO_LARGE", "头像图片不能超过 2 MB。");
    }
}
