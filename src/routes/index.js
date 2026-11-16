import { notFoundResponse, internalErrorResponse } from "../utils/response";
import { logger } from "../utils/logger";
import { getClientIP } from "../utils/security";

export function createRouter(config, webhookHandler) {
    async function dispatchRoutes(request, url) {
        if (request.method === "POST" && url.pathname === config.webhookPath) {
            return webhookHandler.handleWebhook(request);
        }

        return notFoundResponse("Recurso não encontrado");
    }

    return async function handleRoutes(request) {
        const start = performance.now();
        const url = new URL(request.url);
        const method = request.method;
        const path = url.pathname;
        const ip = getClientIP(request);

        try {
            const response = await dispatchRoutes(request, url);
            const duration = `${(performance.now() - start).toFixed(2)}ms`;

            if (response.status >= 400) {
                logger.warn(
                    `${method} ${path} ${response.status} - ${duration} - ${ip}`,
                );
            } else {
                logger.info(
                    `${method} ${path} ${response.status} - ${duration} - ${ip}`,
                );
            }

            return response;
        } catch (err) {
            const duration = `${(performance.now() - start).toFixed(2)}ms`;
            logger.error(
                `${method} ${path} 500 - ${duration} - ${ip} (${err?.message || err})`,
            );
            return internalErrorResponse(err);
        }
    };
}
