import { validateSignature } from "../security/signature";
import { parseEventPayload, extractEventMetadata } from "../models/event.model";
import { getClientIP } from "../utils/security";
import { logger } from "../utils/logger";
import {
    badRequestResponse,
    unauthorizedResponse,
    internalErrorResponse,
    webhookSuccessResponse,
} from "../utils/response";

export class WebhookHandler {
    cfg;
    dispatcher;
    notifier;

    constructor(cfg, dispatcher, notifier) {
        this.cfg = cfg;
        this.dispatcher = dispatcher;
        this.notifier = notifier;
    }

    async handleWebhook(request) {
        const rawArrayBuffer = await request.arrayBuffer();
        const rawBody = Buffer.from(rawArrayBuffer);
        const rawString = rawBody.toString("utf8");
        const headers = Object.fromEntries(request.headers.entries());

        logger.info(
            `[99Food Recebido] URL: ${request.url} | Headers: ${JSON.stringify(headers)} | Body: ${rawString}`,
        );

        if (this.cfg.validateSignature) {
            const signature = request.headers.get("didi-header-sign");
            const isValid = validateSignature(
                this.cfg.appSecret,
                rawBody,
                signature,
            );

            if (!isValid) {
                const ip = getClientIP(request);
                logger.warn(
                    `[Security] Assinatura invalida. IP: ${ip} | Recebida: '${signature}' | SecretLen: ${this.cfg.appSecret?.length || 0} | BodyLen: ${rawBody.length}`,
                );
                this.notifier.notifyError(
                    "WARNING",
                    "Assinatura 99Food Invalida",
                    "Requisicao recebida com assinatura didi-header-sign ausente ou incorreta",
                    `IP: ${ip}`,
                );
                return unauthorizedResponse(
                    "Não foi possível validar a assinatura da solicitação 99Food",
                );
            }
        }

        const trimmedStr = rawBody.toString("utf8").trim();
        if (trimmedStr.length === 0) {
            return badRequestResponse("Os dados informados são inválidos");
        }

        let event;
        try {
            event = parseEventPayload(rawBody);
            if (!event || typeof event !== "object") {
                throw new Error("Payload nao e um objeto valido");
            }
        } catch (err) {
            logger.warn(
                `[Handler] Falha ao desserializar evento 99Food: ${err?.message || err}`,
            );
            this.notifier.notifyError(
                "WARNING",
                "Payload com formato incorreto",
                "Falha ao desserializar evento JSON da 99Food",
                trimmedStr,
            );
            return badRequestResponse("Os dados informados são inválidos");
        }

        const metadata = extractEventMetadata(event);
        if (!metadata || !metadata.type) {
            logger.warn(
                `[Handler] Evento recebido sem campo 'type': ${trimmedStr}`,
            );
            return badRequestResponse("Evento sem identificador de tipo (type)");
        }

        try {
            await this.dispatcher.processEvent(metadata, rawBody);
            return webhookSuccessResponse();
        } catch (err) {
            return internalErrorResponse(err);
        }
    }
}
