import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { existsSync } from "fs";

describe("Rust Proxy Integration", () => {
    test("encaminha requisicao com corpo e cabecalhos intactos atraves do proxy", async () => {
        const isWin = process.platform === "win32";
        const proxyBin = isWin
            ? resolve(import.meta.dir, "../rust-proxy/target/release/webhook-rust-proxy.exe")
            : resolve(import.meta.dir, "../rust-proxy/target/release/webhook-rust-proxy");

        expect(existsSync(proxyBin)).toBe(true);

        const backendPort = 8990;
        const proxyPort = 8991;

        let receivedHeaders = null;
        let receivedBody = null;

        const backendServer = Bun.serve({
            port: backendPort,
            async fetch(req) {
                receivedHeaders = Object.fromEntries(req.headers.entries());
                receivedBody = await req.text();
                return new Response(JSON.stringify({ errno: 0, errmsg: "ok" }), {
                    status: 200,
                    headers: { "Content-Type": "application/json", "X-Server-Id": "bun-test" },
                });
            },
        });

        const proxyProc = Bun.spawn([proxyBin], {
            env: {
                ...process.env,
                PROXY_PORT: String(proxyPort),
                BUN_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
            },
            stdout: "pipe",
            stderr: "inherit",
        });

        // Aguarda inicializacao do proxy
        await new Promise((r) => setTimeout(r, 600));

        try {
            const payload = JSON.stringify({
                app_id: 12345,
                app_shop_id: "store-7093",
                type: "orderNew",
            });

            const res = await fetch(`http://127.0.0.1:${proxyPort}/webhook`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "didi-header-sign": "sig-test-123",
                },
                body: payload,
            });

            expect(res.status).toBe(200);
            expect(res.headers.get("x-server-id")).toBe("bun-test");

            const resJson = await res.json();
            expect(resJson.errno).toBe(0);
            expect(resJson.errmsg).toBe("ok");

            expect(receivedBody).toBe(payload);
            expect(receivedHeaders["didi-header-sign"]).toBe("sig-test-123");
            expect(receivedHeaders["x-real-ip"]).toBe("127.0.0.1");
            expect(receivedHeaders["x-forwarded-for"]).toContain("127.0.0.1");
        } finally {
            proxyProc.kill();
            backendServer.stop();
        }
    });
});
