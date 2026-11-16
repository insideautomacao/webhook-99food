import { describe, test, expect, afterEach } from "bun:test";
import crypto from "crypto";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StoreManager } from "../src/storage/sqlite";
import { RedisQueue } from "../src/queue/redis";
import { Notifier } from "../src/notifier/notifier";
import { Dispatcher } from "../src/services/dispatcher.service";
import { WebhookHandler } from "../src/handlers/webhook.handler";
import { createRouter } from "../src/routes/index";
import { parseEventPayload, extractEventMetadata } from "../src/models/event.model";

describe("WebhookHandler (99Food)", () => {
    let tempDir;
    let storeMgr;
    let redisQ;

    afterEach(async () => {
        if (storeMgr) {
            storeMgr.closeAll();
        }
        if (redisQ) {
            await redisQ.close();
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

    function calcSign(secret, body) {
        return crypto
            .createHash("md5")
            .update(Buffer.from(body, "utf8"))
            .update(Buffer.from(secret, "utf8"))
            .digest("hex");
    }

    test("preserva precisao exata de inteiros de 64 bits (int64/long)", () => {
        const rawJson = `{"app_id": 5764607584567296012, "app_shop_id": "7093", "timestamp": 1615432308, "type": "orderNew", "data": {"order_id": 1152921547153933576, "order_info": {"order_id": 1152921547153933576}}}`;
        const parsed = parseEventPayload(rawJson);
        expect(parsed.data.order_id).toBe("1152921547153933576");
        expect(parsed.app_id).toBe("5764607584567296012");

        const meta = extractEventMetadata(parsed);
        expect(meta.orderId).toBe("1152921547153933576");
        expect(meta.appId).toBe("5764607584567296012");
    });

    test("processa fluxo completo de eventos do webhook 99Food", async () => {
        tempDir = mkdtempSync(join(tmpdir(), "handler_99_test_"));
        const secret = "secret-99food-homologacao";

        const cfg = {
            port: 8080,
            webhookPath: "/webhook",
            appId: "5764607584567296012",
            appSecret: secret,
            validateSignature: true,
            redisQueueName: "99food:events:queue",
            redisQueuePerMerchant: false,
            sqliteDataDir: tempDir,
            telegramAlertsEnabled: false,
            emailAlertsEnabled: false,
        };

        storeMgr = new StoreManager(tempDir);
        redisQ = new RedisQueue({
            redisHost: "127.0.0.1",
            redisPort: 65534, // Porta inativa para validar resiliência do SQLite
        });
        const notif = new Notifier(cfg);
        const disp = new Dispatcher(cfg, storeMgr, redisQ, notif);
        const handler = new WebhookHandler(cfg, disp, notif);
        const handleRoutes = createRouter(cfg, handler);

        // 1. Requisicao com assinatura invalida
        const invalidReq = new Request("http://localhost:8080/webhook", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "didi-header-sign": "assinatura_falsa",
            },
            body: JSON.stringify({ type: "orderNew" }),
        });
        const resp1 = await handleRoutes(invalidReq);
        expect(resp1.status).toBe(401);
        const resp1Json = await resp1.json();
        expect(resp1Json.errno).toBe(1);

        // 2. Requisicao valida de orderNew com IDs int64
        const orderNewBody = JSON.stringify({
            app_id: "5764607584567296012",
            app_shop_id: "7093",
            timestamp: 1615432308,
            type: "orderNew",
            data: {
                order_id: "1152921547153933576",
                order_info: {
                    order_id: "1152921547153933576",
                    status: 100,
                },
                shop: {
                    shop_id: "5764607688097661019",
                    app_shop_id: "7093",
                },
            },
        });
        const orderSig = calcSign(secret, orderNewBody);

        const req2 = new Request("http://localhost:8080/webhook", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "didi-header-sign": orderSig,
            },
            body: orderNewBody,
        });
        const resp2 = await handleRoutes(req2);
        expect(resp2.status).toBe(200);
        const resp2Json = await resp2.json();
        expect(resp2Json.errno).toBe(0);
        expect(resp2Json.errmsg).toBe("ok");

        // Verifica deduplicacao e presenca no SQLite da loja
        const dbFile = join(tempDir, "7093.db");
        expect(existsSync(dbFile)).toBe(true);

        // 3. Reenvio do mesmo evento (duplicata da 99Food)
        const req3 = new Request("http://localhost:8080/webhook", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "didi-header-sign": orderSig,
            },
            body: orderNewBody,
        });
        const resp3 = await handleRoutes(req3);
        expect(resp3.status).toBe(200);
        const resp3Json = await resp3.json();
        expect(resp3Json.errno).toBe(0);

        // 4. Requisicao de evento deliveryStatus
        const deliveryBody = JSON.stringify({
            app_id: "5764607618872501234",
            app_shop_id: "7093",
            timestamp: 1612455327,
            type: "deliveryStatus",
            data: {
                order_id: "5764608647577512345",
                delivery_status: 160,
                rider_name: "Carlos",
            },
        });
        const deliverySig = calcSign(secret, deliveryBody);

        const req4 = new Request("http://localhost:8080/webhook", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "didi-header-sign": deliverySig,
            },
            body: deliveryBody,
        });
        const resp4 = await handleRoutes(req4);
        expect(resp4.status).toBe(200);
        const resp4Json = await resp4.json();
        expect(resp4Json.errno).toBe(0);

        // 5. Requisicao de evento uploadMenuTaskStatus (Menu)
        const menuBody = JSON.stringify({
            app_id: "5764607549658103825",
            app_shop_id: "7093",
            type: "uploadMenuTaskStatus",
            timestamp: 1608191929,
            data: {
                taskID: "3458764561058758717",
                createTime: 1608191921,
                status: 1,
                message: "success",
            },
        });
        const menuSig = calcSign(secret, menuBody);
        const req5 = new Request("http://localhost:8080/webhook", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "didi-header-sign": menuSig,
            },
            body: menuBody,
        });
        const resp5 = await handleRoutes(req5);
        expect(resp5.status).toBe(200);
        const resp5Json = await resp5.json();
        expect(resp5Json.errno).toBe(0);

        // 6. Requisicao de evento orderCancelApply
        const cancelApplyBody = JSON.stringify({
            app_id: "1152921654762997000",
            app_shop_id: "7093",
            type: "orderCancelApply",
            timestamp: 1592970557,
            data: {
                order_id: "1152921654762996500",
                apply_reason: "do not want",
                apply_id: "1152921654813328100",
            },
        });
        const cancelApplySig = calcSign(secret, cancelApplyBody);
        const req6 = new Request("http://localhost:8080/webhook", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "didi-header-sign": cancelApplySig,
            },
            body: cancelApplyBody,
        });
        const resp6 = await handleRoutes(req6);
        expect(resp6.status).toBe(200);
        const resp6Json = await resp6.json();
        expect(resp6Json.errno).toBe(0);
    });
});
