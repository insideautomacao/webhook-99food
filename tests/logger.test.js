import { describe, test, expect, afterEach } from "bun:test";
import {
    mkdtempSync,
    rmSync,
    existsSync,
    readdirSync,
    writeFileSync,
    utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Logger } from "../src/utils/logger";

describe("Logger", () => {
    let tempDir;
    let logger;

    afterEach(async () => {
        if (logger) {
            await logger.close();
        }
        if (tempDir && existsSync(tempDir)) {
            for (let i = 0; i < 5; i++) {
                try {
                    rmSync(tempDir, { recursive: true, force: true });
                    break;
                } catch {
                    await new Promise((r) => setTimeout(r, 50));
                }
            }
        }
    });

    test("grava e rotaciona log em arquivo", async () => {
        tempDir = mkdtempSync(join(tmpdir(), "log_test_"));
        logger = new Logger(tempDir, 60);

        logger.log("teste de log de execucao");
        await logger.flush();

        const files = readdirSync(tempDir);
        expect(files.length).toBeGreaterThan(0);
        expect(files[0].endsWith(".log")).toBe(true);

        const content = await Bun.file(join(tempDir, files[0])).text();
        expect(content).toContain("teste de log de execucao");
    });

    test("expurgo de logs antigos remove arquivos com mais de retentionDays", () => {
        tempDir = mkdtempSync(join(tmpdir(), "log_retention_test_"));
        logger = new Logger(tempDir, 60);

        const recentFile = join(tempDir, "app_recent.log");
        writeFileSync(recentFile, "recente");

        const oldFile = join(tempDir, "app_old.log");
        writeFileSync(oldFile, "antigo");

        // Simula data de modificacao de 65 dias atras
        const oldTime = (Date.now() - 65 * 24 * 60 * 60 * 1000) / 1000;
        utimesSync(oldFile, oldTime, oldTime);

        logger.cleanOldLogs(60);

        expect(existsSync(oldFile)).toBe(false);
        expect(existsSync(recentFile)).toBe(true);
    });
});
