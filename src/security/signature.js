import crypto from "crypto";

export function generateSignature(appSecret, rawBody) {
    if (!appSecret) {
        return "";
    }

    const bodyBuffer = Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(String(rawBody || ""), "utf8");
    const secretBuffer = Buffer.from(String(appSecret), "utf8");

    const hash = crypto.createHash("md5");
    hash.update(bodyBuffer);
    hash.update(secretBuffer);
    return hash.digest("hex").toLowerCase();
}

export function validateSignature(appSecret, rawBody, receivedSignature) {
    if (!appSecret || !receivedSignature) {
        return false;
    }

    try {
        const expectedSignature = generateSignature(appSecret, rawBody);
        const received = String(receivedSignature).toLowerCase().trim();

        const expectedBuf = Buffer.from(expectedSignature, "utf8");
        const receivedBuf = Buffer.from(received, "utf8");

        if (expectedBuf.length !== receivedBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(expectedBuf, receivedBuf);
    } catch {
        return false;
    }
}
