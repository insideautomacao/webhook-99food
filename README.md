# webhook-99 (Bun.js)

Microservico de recepcao, validacao criptografica, persistencia e enfileiramento de webhooks da 99Food (Open Platform) em Bun.js.

## Caracteristicas
- Validacao de assinatura com header `didi-header-sign` via hash MD5 (`raw_body + app_secret`).
- Preservacao de inteiros de 64 bits (`int64` / `long`) via `json-bigint` para evitar perda de precisao em `order_id`, `shop_id` e `app_id`.
- Resposta padrao obrigatoria `{ "errno": 0, "errmsg": "ok" }` com HTTP 200.
- Armazenamento permanente e deduplicacao idempotente no SQLite local particionado por loja.
- Enfileiramento assincrono no Redis com fallback resiliente para eventos pendentes no SQLite caso o Redis esteja indisponivel.
- Proxy reverso opcional em Rust de alta performance.

## Instalacao e Execucao

```bash
# Instalar dependencias
bun install

# Modo desenvolvimento (com auto-reload)
bun dev

# Execucao em producao
bun start

# Executar testes
bun test
```
