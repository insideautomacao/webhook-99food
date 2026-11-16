import { describe, test, expect } from "bun:test";
import { Notifier } from "../src/notifier/notifier";

describe("Notifier", () => {
    test("disparo de alertas e assincrono e nao bloqueante", async () => {
        const cfg = {
            telegramAlertsEnabled: true,
            telegramBotToken: "dummy_token",
            telegramChatId: "dummy_chat",
            emailAlertsEnabled: true,
            smtpHost: "127.0.0.1",
            smtpPort: 65533,
            smtpTo: ["alerta@exemplo.com"],
        };

        const notifier = new Notifier(cfg);

        const start = performance.now();
        notifier.notifyError(
            "ERROR",
            "Teste de Alerta",
            "Mensagem de teste de erro",
            "Detalhe tecnico do erro",
        );
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);

        // Aguarda microtask ser processada sem afetar o fluxo principal
        await new Promise((r) => setTimeout(r, 100));
    });
});
