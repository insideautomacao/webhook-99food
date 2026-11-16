import { logger } from "../utils/logger";

export class Dispatcher {
    cfg;
    storage;
    queue;
    notifier;
    syncInterval = null;

    constructor(cfg, storeManager, redisQueue, notifier) {
        this.cfg = cfg;
        this.storage = storeManager;
        this.queue = redisQueue;
        this.notifier = notifier;
    }

    async processEvent(metadata, rawBody) {
        const storeId = metadata.storeId || "global";
        const eventId = metadata.eventId;

        let isDuplicate = false;
        try {
            isDuplicate = this.storage.saveEvent(
                storeId,
                metadata,
                rawBody,
                "RECEIVED",
            );
        } catch (err) {
            logger.error(
                `[Storage] Erro ao persistir evento no SQLite da loja ${storeId} (ID: ${eventId}): ${err?.message || err}`,
            );
            this.notifier.notifyError(
                "CRITICAL",
                "Falha de persistencia no SQLite",
                `Loja: ${storeId}, Evento: ${eventId}`,
                err?.message || String(err),
            );
            throw err;
        }

        if (isDuplicate) {
            logger.info(
                `[Dedup] Evento duplicado ignorado para a loja ${storeId} (ID: ${eventId})`,
            );
            return { isDuplicate: true };
        }

        let queueName = this.cfg.redisQueueName;
        if (this.cfg.redisQueuePerMerchant && storeId !== "global") {
            queueName = `${this.cfg.redisQueueName}:${storeId}`;
        }

        try {
            await this.queue.enqueue(queueName, rawBody);
            this.storage.updateEventStatus(storeId, eventId, "QUEUED");
            logger.info(
                `[Queue] Evento ${eventId} (${metadata.type}) enfileirado com sucesso para loja ${storeId}`,
            );
        } catch (enqueueErr) {
            logger.warn(
                `[Queue] Falha ao enfileirar no Redis (ID: ${eventId}): ${enqueueErr?.message || enqueueErr}. Mantido em backup permanente.`,
            );
            this.notifier.notifyError(
                "WARNING",
                "Falha de enfileiramento no Redis",
                `Evento mantido em backup no SQLite. Loja: ${storeId}, Evento: ${eventId}, Fila: ${queueName}`,
                enqueueErr?.message || String(enqueueErr),
            );
            this.storage.updateEventStatus(
                storeId,
                eventId,
                "PENDING_QUEUE",
            );
        }

        return { isDuplicate: false };
    }

    startBackgroundSync() {
        this.syncInterval = setInterval(() => {
            this.syncPendingEvents().catch((err) => {
                logger.error(
                    `[Sync] Erro na rotina de sincronizacao de eventos pendentes: ${err?.message || err}`,
                );
            });
        }, 15000);
    }

    async syncPendingEvents() {
        const stores = this.storage.getAllStoreIds();
        if (!stores || stores.length === 0) {
            return;
        }

        for (const storeId of stores) {
            let items = [];
            try {
                items = this.storage.getPendingEvents(storeId, 50);
            } catch {
                continue;
            }

            if (!items || items.length === 0) {
                continue;
            }

            let queueName = this.cfg.redisQueueName;
            if (this.cfg.redisQueuePerMerchant && storeId !== "global") {
                queueName = `${this.cfg.redisQueueName}:${storeId}`;
            }

            for (const item of items) {
                try {
                    await this.queue.enqueue(queueName, item.payload);
                    this.storage.updateEventStatus(storeId, item.id, "QUEUED");
                    logger.info(
                        `[Sync] Evento pendente ${item.id} sincronizado para a fila da loja ${storeId}`,
                    );
                } catch {
                    // Se falhar no Redis, interrompe o lote para evitar overhead
                    return;
                }
            }
        }
    }

    stopBackgroundSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
    }
}
