import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { appendFile } from "fs/promises";
import { join, dirname } from "path";

const pendingWrites = [];
let writeScheduled = false;

export async function flushLogQueue() {
    writeScheduled = false;

    if (pendingWrites.length === 0) return;

    const toWrite = [...pendingWrites];
    pendingWrites.length = 0;
    const grouped = new Map();

    for (let i = 0; i < toWrite.length; i++) {
        const item = toWrite[i];
        let list = grouped.get(item.path);

        if (!list) {
            list = [];
            grouped.set(item.path, list);
        }

        list.push(item.content);
    }

    for (const [filePath, lines] of grouped) {
        try {
            const dir = dirname(filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            await appendFile(filePath, lines.join(""), "utf8");
        } catch (err) {
            console.error(`[ERROR] Falha no appendFile do log: ${err}`);
        }
    }
}

export class Logger {
    dir;
    retentionMs;
    currentHour = "";
    currentFilePath = "";
    cleanupTimer = null;

    constructor(dir = "logs", retentionDays = 60) {
        this.dir = dir;
        this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;
        this.init();
    }

    init() {
        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true });
        }

        this.cleanOldLogs();
        this.cleanupTimer = setInterval(
            () => {
                this.cleanOldLogs();
            },
            60 * 60 * 1000,
        );
    }

    formatHour(date) {
        const pad = (n) => String(n).padStart(2, "0");
        const year = date.getFullYear();
        const month = pad(date.getMonth() + 1);
        const day = pad(date.getDate());
        const hour = pad(date.getHours());

        return `${year}-${month}-${day}_${hour}`;
    }

    formatTimestamp(date) {
        const pad = (n) => String(n).padStart(2, "0");
        const year = date.getFullYear();
        const month = pad(date.getMonth() + 1);
        const day = pad(date.getDate());
        const hour = pad(date.getHours());
        const minute = pad(date.getMinutes());
        const second = pad(date.getSeconds());

        return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    }

    getLogFilePath(now) {
        const hourStr = this.formatHour(now);

        if (this.currentHour !== hourStr) {
            this.currentHour = hourStr;
            this.currentFilePath = join(this.dir, `app_${hourStr}.log`);
        }

        return this.currentFilePath;
    }

    writeToFile(filePath, line) {
        pendingWrites.push({ path: filePath, content: line });

        if (!writeScheduled) {
            writeScheduled = true;
            setTimeout(flushLogQueue, 50);
        }
    }

    write(level, message, ...args) {
        const now = new Date();
        const timestamp = this.formatTimestamp(now);
        const formattedArgs =
            args.length > 0
                ? " " +
                  args
                      .map((a) =>
                          typeof a === "object" ? JSON.stringify(a) : String(a),
                      )
                      .join(" ")
                : "";
        const line = `[${timestamp}] [${level}] ${message}${formattedArgs}\n`;

        try {
            const filePath = this.getLogFilePath(now);
            this.writeToFile(filePath, line);
        } catch (err) {
            console.error(`[ERROR] Falha ao gravar log em arquivo: ${err}`);
        }

        if (level === "ERROR") {
            process.stderr.write(line);
        } else {
            process.stdout.write(line);
        }
    }

    log(message, ...args) {
        this.write("LOG", message, ...args);
    }

    info(message, ...args) {
        this.write("INFO", message, ...args);
    }

    warn(message, ...args) {
        this.write("WARN", message, ...args);
    }

    error(message, ...args) {
        this.write("ERROR", message, ...args);
    }

    cleanOldLogs(retentionDays) {
        try {
            if (!existsSync(this.dir)) return;

            const retention =
                typeof retentionDays === "number"
                    ? retentionDays * 24 * 60 * 60 * 1000
                    : this.retentionMs;

            const files = readdirSync(this.dir);
            const threshold = Date.now() - retention;

            for (const file of files) {
                if (!file.endsWith(".log")) continue;

                const fullPath = join(this.dir, file);
                const stats = statSync(fullPath);

                if (stats.mtimeMs < threshold) {
                    unlinkSync(fullPath);
                }
            }
        } catch (err) {
            console.error(`[ERROR] Falha na limpeza de logs antigos: ${err}`);
        }
    }

    async flush() {
        await flushLogQueue();
    }

    async close() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        await flushLogQueue();
    }
}

export const logger = new Logger(
    process.env.LOGS_DIR || "./logs",
    Number(process.env.LOG_RETENTION_DAYS || "60") || 60,
);
