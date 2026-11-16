export function getClientIP(request) {
    const forwardedFor = request.headers.get("x-forwarded-for");

    if (forwardedFor) {
        return forwardedFor.split(",")[0]?.trim() || "";
    }

    return request.headers.get("x-real-ip") || "127.0.0.1";
}
