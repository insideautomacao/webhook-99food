function getEnv(key, defaultVal) {
    const val = process.env[key];
    if (val !== undefined && val !== "") {
        return val;
    }
    return defaultVal;
}

function getEnvAsBool(key, defaultVal) {
    const val = process.env[key];
    if (val === undefined || val === "") {
        return defaultVal;
    }
    const lower = String(val).toLowerCase().trim();
    if (lower === "true" || lower === "1" || lower === "yes") {
        return true;
    }
    if (lower === "false" || lower === "0" || lower === "no") {
        return false;
    }
    return defaultVal;
}

function getEnvAsInt(key, defaultVal) {
    const val = process.env[key];
    if (val === undefined || val === "") {
        return defaultVal;
    }
    const parsed = parseInt(val, 10);
    return Number.isNaN(parsed) ? defaultVal : parsed;
}

function getEnvAsSlice(key, defaultVal = []) {
    const val = process.env[key];
    if (val === undefined || val === "") {
        return defaultVal;
    }
    return val
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
}

export function loadConfig() {
    return {
        port: Number(getEnv("PORT", "8080")),
        webhookPath: getEnv("WEBHOOK_PATH", "/webhook"),
        appId: getEnv("FOOD_99_APP_ID", ""),
        appSecret: getEnv("FOOD_99_APP_SECRET", ""),
        validateSignature: getEnvAsBool("VALIDATE_SIGNATURE", true),
        redisHost: getEnv("REDIS_HOST", "127.0.0.1"),
        redisPort: getEnvAsInt("REDIS_PORT", 6379),
        redisPassword: getEnv("REDIS_PASSWORD", ""),
        redisDb: getEnvAsInt("REDIS_DB", 0),
        redisQueueName: getEnv("REDIS_QUEUE_NAME", "99food:events:queue"),
        redisQueuePerMerchant: getEnvAsBool("REDIS_QUEUE_PER_MERCHANT", false),
        sqliteDataDir: getEnv("SQLITE_DATA_DIR", "./data/merchants"),

        telegramAlertsEnabled: getEnvAsBool("TELEGRAM_ALERTS_ENABLED", false),
        telegramBotToken: getEnv("TELEGRAM_BOT_TOKEN", ""),
        telegramChatId: getEnv("TELEGRAM_CHAT_ID", ""),

        emailAlertsEnabled: getEnvAsBool("EMAIL_ALERTS_ENABLED", false),
        smtpHost: getEnv("SMTP_HOST", ""),
        smtpPort: getEnvAsInt("SMTP_PORT", 587),
        smtpUser: getEnv("SMTP_USER", ""),
        smtpPassword: getEnv("SMTP_PASSWORD", ""),
        smtpFrom: getEnv("SMTP_FROM", ""),
        smtpTo: getEnvAsSlice("SMTP_TO", []),

        logsDir: getEnv("LOGS_DIR", "./logs"),
        logRetentionDays: getEnvAsInt("LOG_RETENTION_DAYS", 60),
    };
}

export const config = loadConfig();
