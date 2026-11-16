import { describe, test, expect } from "bun:test";
import crypto from "crypto";
import { validateSignature, generateSignature } from "../src/security/signature";

describe("Security - validateSignature (99Food)", () => {
    test("valida assinatura MD5 correta (rawBody + appSecret)", () => {
        const appSecret = "1234567890abcdef1234567890abcdef";
        const body = Buffer.from(
            JSON.stringify({
                app_id: 12345,
                app_shop_id: "7093",
                type: "orderNew",
                timestamp: 1615432308,
            }),
        );

        const expectedSig = crypto
            .createHash("md5")
            .update(body)
            .update(Buffer.from(appSecret, "utf8"))
            .digest("hex");

        expect(generateSignature(appSecret, body)).toBe(expectedSig);
        expect(validateSignature(appSecret, body, expectedSig)).toBe(true);
    });

    test("rejeita assinatura incorreta", () => {
        const appSecret = "1234567890abcdef1234567890abcdef";
        const body = Buffer.from("test body");

        expect(validateSignature(appSecret, body, "assinatura_invalida")).toBe(
            false,
        );
    });

    test("rejeita quando appSecret for vazio", () => {
        const body = Buffer.from("test body");
        expect(validateSignature("", body, "qualquer")).toBe(false);
    });
});
