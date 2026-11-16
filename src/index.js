import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import embeddedRustCargoToml from "../rust-proxy/Cargo.toml" with { type: "file" };
import embeddedRustMainRs from "../rust-proxy/src/main.rs" with { type: "file" };
import { config } from "./config/config";
import { logger } from "./utils/logger";
import { StoreManager } from "./storage/sqlite";
import { RedisQueue } from "./queue/redis";
import { Notifier } from "./notifier/notifier";
import { Dispatcher } from "./services/dispatcher.service";
import { WebhookHandler } from "./handlers/webhook.handler";
import { createRouter } from "./routes/index";

const isWin = process.platform === "win32";
const unixSocketPath = !isWin
    ? process.env.BUN_UNIX_SOCKET || "/tmp/webhook-99-bun.sock"
    : "";

const storeManager = new StoreManager(config.sqliteDataDir);
const redisQueue = new RedisQueue(config);
const notifier = new Notifier(config);
const dispatcher = new Dispatcher(config, storeManager, redisQueue, notifier);
const webhookHandler = new WebhookHandler(config, dispatcher, notifier);
const handleRoutes = createRouter(config, webhookHandler);

dispatcher.startBackgroundSync();

const serverHandlers = {
    maxRequestBodySize: 10 * 1024 * 1024,
    fetch(request) {
        return handleRoutes(request);
    },
};

const server = Bun.serve({
    port: config.port,
    ...serverHandlers,
});

let unixServer = null;

if (unixSocketPath) {
    try {
        if (existsSync(unixSocketPath)) {
            unlinkSync(unixSocketPath);
        }

        unixServer = Bun.serve({
            unix: unixSocketPath,
            ...serverHandlers,
        });
        logger.log(`Socket Unix ativo em ${unixSocketPath}`);
    } catch (err) {
        logger.warn(
            `Nao foi possivel iniciar socket Unix (${unixSocketPath}):`,
            err,
        );
    }
}

logger.log(
    `Servidor de webhook 99Food iniciado na porta ${config.port} (rota: ${config.webhookPath})`,
);

let proxyProc = null;
let isShuttingDown = false;

function resolveProxyBinary() {
    const exeDir = dirname(process.execPath);
    const cwd = process.cwd();

    const rustCandidates = isWin
        ? [
              resolve(cwd, "rust-proxy/target/release/webhook-rust-proxy.exe"),
              resolve(exeDir, "webhook-rust-proxy.exe"),
              resolve(
                  exeDir,
                  "../../rust-proxy/target/release/webhook-rust-proxy.exe",
              ),
          ]
        : [
              resolve(cwd, "rust-proxy/target/release/webhook-rust-proxy"),
              resolve(exeDir, "webhook-rust-proxy"),
              "/tmp/webhook-99-rust-proxy/target/release/webhook-rust-proxy",
              resolve(
                  exeDir,
                  "../../rust-proxy/target/release/webhook-rust-proxy",
              ),
          ];

    if (!isWin) {
        const tmpRustDir = "/tmp/webhook-99-rust-proxy";
        const tmpSrcDir = `${tmpRustDir}/src`;
        const embeddedMainContent = readFileSync(embeddedRustMainRs);
        const embeddedCargoContent = readFileSync(embeddedRustCargoToml);
        const currentMainContent = existsSync(`${tmpSrcDir}/main.rs`)
            ? readFileSync(`${tmpSrcDir}/main.rs`)
            : null;
        const currentCargoContent = existsSync(`${tmpRustDir}/Cargo.toml`)
            ? readFileSync(`${tmpRustDir}/Cargo.toml`)
            : null;
        const sourceChanged =
            !currentMainContent ||
            !currentCargoContent ||
            Buffer.compare(embeddedMainContent, currentMainContent) !== 0 ||
            Buffer.compare(embeddedCargoContent, currentCargoContent) !== 0;
        const hasRustBin = rustCandidates.some((p) => existsSync(p));

        if (!hasRustBin || sourceChanged) {
            try {
                mkdirSync(tmpSrcDir, { recursive: true });
                writeFileSync(
                    `${tmpRustDir}/Cargo.toml`,
                    embeddedCargoContent,
                );
                writeFileSync(`${tmpSrcDir}/main.rs`, embeddedMainContent);

                const cargoBins = [
                    "/root/.cargo/bin/cargo",
                    `${process.env.HOME || "/root"}/.cargo/bin/cargo`,
                    "cargo",
                ];
                const cargoCmd =
                    cargoBins.find((c) => c === "cargo" || existsSync(c)) ||
                    "cargo";

                logger.log(
                    `[Proxy] Compilando Rust Proxy embutido em ${tmpRustDir} usando ${cargoCmd}...`,
                );
                const buildRes = Bun.spawnSync(
                    [cargoCmd, "build", "--release"],
                    {
                        cwd: tmpRustDir,
                        env: {
                            ...process.env,
                            PATH: `/root/.cargo/bin:${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
                        },
                        stdout: "inherit",
                        stderr: "inherit",
                    },
                );

                if (buildRes.exitCode !== 0) {
                    logger.warn(
                        "[Proxy] Compilacao do Rust falhou no Linux.",
                    );
                }
            } catch (err) {
                logger.warn(
                    `[Proxy] Cargo nao disponivel (${err.message}).`,
                );
            }
        }
    }

    for (const candidate of rustCandidates) {
        if (existsSync(candidate)) {
            if (!isWin) {
                try {
                    chmodSync(candidate, 0o755);
                } catch {}
            }
            return candidate;
        }
    }

    return null;
}

function consumeProxyStdout(stream) {
    if (!stream) {
        return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    (async () => {
        try {
            for await (const chunk of stream) {
                buffer += decoder.decode(chunk, { stream: true });
                let newlineIdx;

                while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, newlineIdx).trim();

                    buffer = buffer.slice(newlineIdx + 1);

                    if (!line) {
                        continue;
                    }

                    if (line.startsWith("__PROXY_LOG__|")) {
                        const firstSep = line.indexOf("|", 14);

                        if (firstSep !== -1) {
                            const status = Number(line.slice(14, firstSep));
                            const msg = line.slice(firstSep + 1);

                            if (status >= 400) {
                                logger.warn(msg);
                            } else {
                                logger.info(msg);
                            }

                            continue;
                        }
                    }

                    process.stdout.write(`${line}\n`);
                }
            }
        } catch {}
    })();
}

function startProxyProcess() {
    if (
        isShuttingDown ||
        String(process.env.AUTO_START_PROXY).toLowerCase() === "false"
    ) {
        return;
    }

    const binPath = resolveProxyBinary();

    if (!binPath) {
        logger.warn("[Proxy] Nenhum binario de proxy Rust encontrado.");
        return;
    }

    const proxyPort = process.env.PROXY_PORT || "8081";

    try {
        proxyProc = Bun.spawn([binPath], {
            cwd: dirname(binPath),
            env: {
                ...process.env,
                PROXY_PORT: proxyPort,
                BUN_BACKEND_URL: `http://127.0.0.1:${config.port}`,
                BUN_UNIX_SOCKET: unixSocketPath,
            },
            stdout: "pipe",
            stderr: "inherit",
            onExit(_proc, exitCode) {
                if (!isShuttingDown) {
                    logger.warn(
                        `[Proxy] Processo encerrado (code=${exitCode}). Reiniciando em 1s...`,
                    );
                    setTimeout(() => startProxyProcess(), 1000);
                }
            },
        });
        consumeProxyStdout(proxyProc.stdout);
        logger.log(
            `[Proxy] Inicializado automaticamente: ${binPath} (porta ${proxyPort})`,
        );
    } catch (err) {
        logger.error("[Proxy] Falha ao iniciar processo do proxy:", err);
    }
}

startProxyProcess();

async function gracefulShutdown(signal) {
    isShuttingDown = true;
    logger.log(`Sinal ${signal} recebido, finalizando servicos...`);

    try {
        if (proxyProc) {
            try {
                proxyProc.kill();
            } catch {}
        }

        dispatcher.stopBackgroundSync();
        server.stop();

        if (unixServer) {
            unixServer.stop();
        }

        if (unixSocketPath && existsSync(unixSocketPath)) {
            unlinkSync(unixSocketPath);
        }

        storeManager.closeAll();
        await redisQueue.close();
        logger.log("Servidor finalizado com sucesso");
    } catch (err) {
        logger.error("Erro ao finalizar servicos:", err);
    } finally {
        await logger.close();
    }

    process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
