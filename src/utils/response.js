import { ErrorCodes, ErrorMessages } from "./errors";

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

export function webhookErrorResponse(
    status = 400,
    errmsg = "err text",
    errno = 1,
) {
    return jsonResponse(
        {
            errno,
            errmsg,
        },
        status,
    );
}

export function notFoundResponse(message = ErrorMessages.NOT_FOUND) {
    return webhookErrorResponse(404, message, 1);
}

export function badRequestResponse(message = ErrorMessages.INVALID_REQUEST) {
    return webhookErrorResponse(400, message, 1);
}

export function unauthorizedResponse(message = ErrorMessages.INVALID_SIGNATURE) {
    return webhookErrorResponse(401, message, 1);
}

export function internalErrorResponse(err) {
    const msg = err?.message || ErrorMessages.INTERNAL_ERROR;
    return webhookErrorResponse(500, msg, 1);
}
