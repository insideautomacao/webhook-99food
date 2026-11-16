import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StoreManager } from "../src/storage/sqlite";

describe("Storage - SQLite StoreManager (99Food)", () => {
    let tempDir;
    let manager;

    afterEach(async () => {
        if (manager) {
            manager.closeAll();
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

    test("salva evento e deduplica corretamente", () => {
        tempDir = mkdtempSync(join(tmpdir(), "sqlite_test_"));
        manager = new StoreManager(tempDir);

        const storeId = "store-7093";
        const metadata = {
            eventId: "orderNew:1152921547153933576:1615432308",
            type: "orderNew",
            appId: "5764607584567296012",
            storeId,
            orderId: "1152921547153933576",
            timestamp: 1615432308,
        };
        const payload = Buffer.from(JSON.stringify(metadata));

        // Primeira insercao
        const isDup1 = manager.saveEvent(
            storeId,
            metadata,
            payload,
            "RECEIVED",
        );
        expect(isDup1).toBe(false);

        // Verifica se arquivo da loja foi criado
        const dbFile = join(tempDir, `${storeId}.db`);
        expect(existsSync(dbFile)).toBe(true);

        // Segunda insercao com mesmo ID (duplicata)
        const isDup2 = manager.saveEvent(
            storeId,
            metadata,
            payload,
            "RECEIVED",
        );
        expect(isDup2).toBe(true);

        // Checagem com isDuplicate
        expect(manager.isDuplicate(storeId, metadata.eventId)).toBe(true);
        expect(manager.isDuplicate(storeId, "inexistente")).toBe(false);
    });

    test("atualiza status e recupera eventos pendentes", () => {
        tempDir = mkdtempSync(join(tmpdir(), "sqlite_test_"));
        manager = new StoreManager(tempDir);

        const storeId = "store-xyz";
        const metadata = {
            eventId: "evt-pending-1",
            type: "orderConfirm",
            appId: "123",
            storeId,
            orderId: "ord-1",
            timestamp: 1615432308,
        };
        const payload = Buffer.from(JSON.stringify(metadata));

        manager.saveEvent(storeId, metadata, payload, "PENDING_QUEUE");

        const pending = manager.getPendingEvents(storeId, 10);
        expect(pending.length).toBe(1);
        expect(pending[0].id).toBe("evt-pending-1");

        manager.updateEventStatus(storeId, "evt-pending-1", "QUEUED");
        const pendingAfter = manager.getPendingEvents(storeId, 10);
        expect(pendingAfter.length).toBe(0);
    });
});
