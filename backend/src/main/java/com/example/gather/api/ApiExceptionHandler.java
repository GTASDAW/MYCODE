package com.example.gather.api;

import com.example.gather.api.ApiModels.ErrorView;
import com.example.gather.monitoring.RequestObservationFilter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class ApiExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    ResponseEntity<ErrorView> businessError(ApiException exception, HttpServletRequest request) {
        mark(request, exception);
        return ResponseEntity.status(exception.status()).body(new ErrorView(exception.code(), exception.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ErrorView> invalidFields(MethodArgumentNotValidException exception, HttpServletRequest request) {
        mark(request, exception);
        String message = exception.getBindingResult().getFieldErrors().stream().findFirst()
            .map(error -> error.getDefaultMessage()).orElse("请求参数不正确");
        return ResponseEntity.badRequest().body(new ErrorView("VALIDATION_ERROR", message));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class, ConstraintViolationException.class})
    ResponseEntity<ErrorView> invalidRequest(Exception exception, HttpServletRequest request) {
        mark(request, exception);
        return ResponseEntity.badRequest().body(new ErrorView("VALIDATION_ERROR", "请求格式或参数不正确"));
    }

    @ExceptionHandler(AccessDeniedException.class)
    ResponseEntity<ErrorView> denied(AccessDeniedException exception, HttpServletRequest request) {
        mark(request, exception);
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(new ErrorView("FORBIDDEN", "没有执行此操作的权限"));
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    ResponseEntity<ErrorView> constraint(DataIntegrityViolationException exception, HttpServletRequest request) {
        safeFailure(request, exception, false);
        return ResponseEntity.status(HttpStatus.CONFLICT).body(new ErrorView("DATA_CONFLICT", "数据状态发生冲突，请刷新后重试"));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    ResponseEntity<ErrorView> missing(NoResourceFoundException exception, HttpServletRequest request) {
        mark(request, exception);
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(new ErrorView("NOT_FOUND", "请求的资源不存在"));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    ResponseEntity<ErrorView> methodNotAllowed(HttpRequestMethodNotSupportedException exception, HttpServletRequest request) {
        mark(request, exception);
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(new ErrorView("METHOD_NOT_ALLOWED", "请求方法不支持"));
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ErrorView> unexpected(Exception exception, HttpServletRequest request) {
        safeFailure(request, exception, true);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(new ErrorView("INTERNAL_ERROR", "服务暂时不可用，请稍后重试"));
    }

    private static void mark(HttpServletRequest request, Exception exception) {
        request.setAttribute(RequestObservationFilter.EXCEPTION_ATTRIBUTE, exception.getClass().getName());
    }

    private static void safeFailure(HttpServletRequest request, Exception exception, boolean unexpected) {
        mark(request, exception);
        var event = (unexpected ? log.atError() : log.atWarn()).addKeyValue("event", "api_failure")
            .addKeyValue("exceptionType", exception.getClass().getName());
        if (exception.getStackTrace().length > 0) event.addKeyValue("frame", exception.getStackTrace()[0].toString());
        // Throwable messages and causes can include JDBC URLs, query values, or credentials.
        event.log(unexpected ? "Unexpected API failure" : "Database rejected an inconsistent write");
    }
}
