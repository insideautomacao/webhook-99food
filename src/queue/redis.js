import Redis from "ioredis";
import { logger } from "../utils/logger";

export class RedisQueue {
    client;

    constructor(cfg) {
        this.client = new Redis({
            host: cfg.redisHost || "127.0.0.1",
            port: cfg.redisPort || 6379,
            password: cfg.redisPassword || undefined,
            db: cfg.redisDb || 0,
            connectTimeout: 3000,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            retryStrategy(times) {
                return Math.min(times * 1000, 5000);
            },
            lazyConnect: true,
        });

        this.client.on("error", (err) => {
            logger.warn(
                `[Redis] Aviso de conexao com o Redis (${cfg.redisHost}:${cfg.redisPort}): ${err?.message || err}`,
            );
        });

        this.client.connect().catch((err) => {
            logger.warn(
                `[Redis] Aviso: Conexao inicial com o Redis falhou (${cfg.redisHost}:${cfg.redisPort}): ${err?.message || err}. Operacoes serao armazenadas em SQLite ate restabelecimento.`,
            );
        });
    }

    async enqueue(queueName, payload) {
        const data = Buffer.isBuffer(payload)
            ? payload
            : typeof payload === "string"
              ? Buffer.from(payload, "utf8")
              : Buffer.from(JSON.stringify(payload), "utf8");

        await this.client.rpush(queueName, data);
    }

    async tryLockEvent(lockKey, ttlSeconds = 60) {
        const result = await this.client.set(
            lockKey,
            "1",
            "EX",
            ttlSeconds,
            "NX",
        );
        return result === "OK";
    }

    async getOnlineMerchants(merchantIds, maxRecencySeconds = 60) {
        if (!Array.isArray(merchantIds) || merchantIds.length === 0) {
            return [];
        }

        const keys = merchantIds.map((id) => `ifood:presence:merchant:${id}`);
        let values = [];

        try {
            values = await this.client.mget(...keys);
        } catch (err) {
            logger.warn(
                `[Redis] Erro ao consultar presenca de merchants via mget: ${err?.message || err}`,
            );
            return [];
        }

        const online = [];
        const now = Date.now();
        const maxAgeMs = maxRecencySeconds * 1000;

        for (let i = 0; i < merchantIds.length; i++) {
            const raw = values[i];
            if (!raw) continue;

            let parsed = null;
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = { last_seen: Number(raw) || now };
            }

            const lastSeen = Number(parsed?.last_seen) || 0;
            if (!lastSeen || now - lastSeen <= maxAgeMs) {
                online.push(merchantIds[i]);
            }
        }

        return online;
    }

    async close() {
        try {
            await this.client.quit();
        } catch {
            this.client.disconnect();
        }
    }
}
