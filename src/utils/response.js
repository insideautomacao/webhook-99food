import { ErrorCodes, ErrorMessages, newErrorId } from "./errors";

export function errorResponse(status, code, message, id) {
    const errorId = id || newErrorId();
    const errorMessage =
        message ||
        ErrorMessages[code] ||
        "Não foi possível processar a operação";

    const body = {
        id: errorId,
        code,
        message: errorMessage,
        success: false,
    };

    return Response.json(body, {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
    });
}

export function jsonResponse(data, status = 200, headers = {}) {
    return Response.json(data, {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...headers,
        },
    });
}

export function webhookSuccessResponse() {
    return jsonResponse({
        errno: 0,
        errmsg: "ok",
    }, 200);
}

export function notFoundResponse(
    message = ErrorMessages.NOT_FOUND,
    code = ErrorCodes.NOT_FOUND,
) {
    return errorResponse(404, code, message);
}

export function badRequestResponse(
    message = ErrorMessages.INVALID_REQUEST,
    code = ErrorCodes.INVALID_REQUEST,
) {
    return errorResponse(400, code, message);
}

export function unauthorizedResponse(
    message = ErrorMessages.INVALID_SIGNATURE,
    code = ErrorCodes.INVALID_SIGNATURE,
) {
    return errorResponse(401, code, message);
}

export function internalErrorResponse(err) {
    return errorResponse(
        500,
        ErrorCodes.INTERNAL_ERROR,
        ErrorMessages.INTERNAL_ERROR,
    );
}
