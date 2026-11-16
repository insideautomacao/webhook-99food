import crypto from "crypto";
import JSONBig from "json-bigint";

const jsonBigParser = JSONBig({ storeAsString: true });

export function parseEventPayload(rawBody) {
    const str = Buffer.isBuffer(rawBody)
        ? rawBody.toString("utf8")
        : String(rawBody);
    return jsonBigParser.parse(str);
}

export function extractEventMetadata(event) {
    if (!event || typeof event !== "object") {
        return null;
    }

    const type = String(event.type || "").trim();
    const appId = event.app_id ? String(event.app_id) : "";
    const timestamp = Number(event.timestamp) || Math.floor(Date.now() / 1000);

    const rawData = event.data;
    const data = Array.isArray(rawData) ? rawData[0] || {} : rawData || {};
    let orderId = null;
    if (data.order_id !== undefined && data.order_id !== null) {
        orderId = String(data.order_id);
    } else if (
        data.order_info &&
        data.order_info.order_id !== undefined &&
        data.order_info.order_id !== null
    ) {
        orderId = String(data.order_info.order_id);
    }

    let storeId = "";
    if (event.app_shop_id) {
        storeId = String(event.app_shop_id);
    } else if (data.appShopID) {
        storeId = String(data.appShopID);
    } else if (data.app_shop_id) {
        storeId = String(data.app_shop_id);
    } else if (data.shop_id) {
        storeId = String(data.shop_id);
    } else if (data.shop && data.shop.app_shop_id) {
        storeId = String(data.shop.app_shop_id);
    } else if (data.shop && data.shop.shop_id) {
        storeId = String(data.shop.shop_id);
    } else if (Array.isArray(data.appShopIDList) && data.appShopIDList.length > 0) {
        storeId = String(data.appShopIDList[0]);
    }

    const payloadDigest = crypto
        .createHash("md5")
        .update(JSON.stringify(rawData || {}))
        .digest("hex")
        .slice(0, 10);

    const entityId =
        orderId ||
        (data.taskID !== undefined ? String(data.taskID) : null) ||
        (data.apply_id !== undefined ? String(data.apply_id) : null) ||
        (data.app_item_id !== undefined ? String(data.app_item_id) : null) ||
        timestamp;

    const eventId = `${type}:${entityId}:${timestamp}:${payloadDigest}`;

    return {
        eventId,
        type,
        appId,
        storeId,
        orderId,
        timestamp,
    };
}
