import crypto from "crypto";

export function newErrorId() {
    const rawId = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    return `err_${rawId}`;
}

export const ErrorCodes = {
    INVALID_SIGNATURE: "INVALID_SIGNATURE",
    INVALID_REQUEST: "INVALID_REQUEST",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    NOT_FOUND: "NOT_FOUND",
};

export const ErrorMessages = {
    INVALID_SIGNATURE: "Não foi possível validar a assinatura da solicitação 99Food",
    INVALID_REQUEST: "Os dados informados são inválidos",
    INTERNAL_ERROR: "Não foi possível processar a operação",
    NOT_FOUND: "Recurso não encontrado",
};
