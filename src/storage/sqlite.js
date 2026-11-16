import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

export class StoreManager {
    baseDir;
    stores = new Map();

    constructor(baseDir = "./data/merchants") {
        this.baseDir = baseDir;
        if (!existsSync(this.baseDir)) {
            mkdirSync(this.baseDir, { recursive: true });
        }
    }

    cleanStoreId(storeId) {
        if (!storeId || typeof storeId !== "string") {
            return "";
        }
        return storeId
            .replace(/[/\\]/g, "")
            .trim();
    }

    getStore(storeId) {
        const cleanId = this.cleanStoreId(storeId);
        if (!cleanId) {
            throw new Error("storeId inválido");
        }

        let store = this.stores.get(cleanId);
        if (store) {
            return store;
        }

        const dbPath = join(this.baseDir, `${cleanId}.db`);
        const db = new Database(dbPath, { create: true });

        db.exec("PRAGMA journal_mode = WAL;");
        db.exec("PRAGMA synchronous = NORMAL;");
        db.exec("PRAGMA busy_timeout = 5000;");

        const schema = `
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            type TEXT,
            order_id TEXT,
            app_id TEXT,
            app_shop_id TEXT,
            payload TEXT NOT NULL,
            status TEXT NOT NULL,
            event_timestamp INTEGER,
            received_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_events_order_id ON events (order_id);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
        CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);
        `;
        db.exec(schema);

        const statements = {
            isDuplicate: db.prepare("SELECT 1 FROM events WHERE id = ? LIMIT 1"),
            save: db.prepare(`
                INSERT INTO events (id, type, order_id, app_id, app_shop_id, payload, status, event_timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING;
            `),
            updateStatus: db.prepare(
                "UPDATE events SET status = ? WHERE id = ?",
            ),
            getPending: db.prepare(
                "SELECT id, payload FROM events WHERE status = 'PENDING_QUEUE' ORDER BY received_at ASC LIMIT ?",
            ),
        };

        store = { db, statements };
        this.stores.set(cleanId, store);
        return store;
    }

    isDuplicate(storeId, eventId) {
        const { statements } = this.getStore(storeId);
        const row = statements.isDuplicate.get(eventId);
        return Boolean(row);
    }

    saveEvent(storeId, metadata, rawPayload, status = "RECEIVED") {
        const { statements } = this.getStore(storeId);

        const payloadStr =
            typeof rawPayload === "string"
                ? rawPayload
                : Buffer.isBuffer(rawPayload)
                  ? rawPayload.toString("utf8")
                  : JSON.stringify(rawPayload);

        const result = statements.save.run(
            metadata.eventId,
            metadata.type || null,
            metadata.orderId || null,
            metadata.appId || null,
            storeId,
            payloadStr,
            status,
            metadata.timestamp || null,
        );

        if (result.changes === 0) {
            return true;
        }

        return false;
    }

    updateEventStatus(storeId, eventId, status) {
        const { statements } = this.getStore(storeId);
        statements.updateStatus.run(status, eventId);
    }

    getPendingEvents(storeId, limit = 50) {
        const { statements } = this.getStore(storeId);
        const rows = statements.getPending.all(limit);

        return rows.map((row) => ({
            id: row.id,
            storeId,
            payload: Buffer.from(row.payload, "utf8"),
        }));
    }

    getAllStoreIds() {
        if (!existsSync(this.baseDir)) {
            return [];
        }

        const entries = readdirSync(this.baseDir);
        const ids = [];

        for (const entry of entries) {
            if (entry.endsWith(".db")) {
                ids.push(entry.slice(0, -3));
            }
        }

        return ids;
    }

    closeAll() {
        for (const [key, store] of this.stores.entries()) {
            try {
                if (store.statements) {
                    for (const stmt of Object.values(store.statements)) {
                        try {
                            stmt.finalize();
                        } catch {}
                    }
                }
                try {
                    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
                } catch {}
                store.db.close();
            } catch {}
        }
        this.stores.clear();
    }
}
