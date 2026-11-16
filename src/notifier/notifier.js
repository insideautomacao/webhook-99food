import nodemailer from "nodemailer";
import { logger } from "../utils/logger";

export class Notifier {
    cfg;
    mailTransporter = null;

    constructor(cfg) {
        this.cfg = cfg;

        if (this.cfg.emailAlertsEnabled && this.cfg.smtpHost) {
            const auth =
                this.cfg.smtpUser && this.cfg.smtpPassword
                    ? {
                          user: this.cfg.smtpUser,
                          pass: this.cfg.smtpPassword,
                      }
                    : undefined;

            this.mailTransporter = nodemailer.createTransport({
                host: this.cfg.smtpHost,
                port: this.cfg.smtpPort || 587,
                secure: this.cfg.smtpPort === 465,
                auth,
                connectionTimeout: 5000,
                greetingTimeout: 5000,
                socketTimeout: 5000,
            });
        }
    }

    notifyError(level, title, message, details) {
        const item = {
            level: level || "ERROR",
            title: title || "",
            message: message || "",
            details: details || "",
            timestamp: new Date(),
        };

        queueMicrotask(async () => {
            try {
                if (this.cfg.telegramAlertsEnabled) {
                    await this.sendTelegram(item).catch((err) => {
                        logger.error(
                            `[Notifier] Falha ao enviar alerta para Telegram: ${err?.message || err}`,
                        );
                    });
                }

                if (this.cfg.emailAlertsEnabled) {
                    await this.sendEmail(item).catch((err) => {
                        logger.error(
                            `[Notifier] Falha ao enviar alerta por e-mail: ${err?.message || err}`,
                        );
                    });
                }
            } catch (err) {
                logger.error(
                    `[Notifier] Erro inesperado no processamento de alertas: ${err?.message || err}`,
                );
            }
        });
    }

    formatUtcDate(date) {
        return date.toISOString().replace("T", " ").replace(/\..+/, " UTC");
    }

    async sendTelegram(item) {
        if (!this.cfg.telegramBotToken || !this.cfg.telegramChatId) {
            return;
        }

        const url = `https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`;
        const textParts = [
            `[${item.level}] ${item.title}`,
            `Data/Hora: ${this.formatUtcDate(item.timestamp)}`,
            `Mensagem: ${item.message}`,
        ];

        if (item.details) {
            textParts.push(`Detalhes: ${item.details}`);
        }

        const body = {
            chat_id: this.cfg.telegramChatId,
            text: textParts.join("\n"),
        };

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            logger.warn(
                `[Notifier] Telegram API retornou status HTTP ${response.status}`,
            );
        }
    }

    async sendEmail(item) {
        if (
            !this.mailTransporter ||
            !this.cfg.smtpTo ||
            this.cfg.smtpTo.length === 0
        ) {
            return;
        }

        const from = this.cfg.smtpFrom || this.cfg.smtpUser;
        const subject = `[${item.level}] ${item.title}`;

        const bodyLines = [
            `Nivel: ${item.level}`,
            `Data/Hora: ${this.formatUtcDate(item.timestamp)}`,
            `Mensagem: ${item.message}`,
        ];

        if (item.details) {
            bodyLines.push(`Detalhes:\r\n${item.details}`);
        }

        await this.mailTransporter.sendMail({
            from,
            to: this.cfg.smtpTo.join(", "),
            subject,
            text: bodyLines.join("\r\n"),
        });
    }
}
