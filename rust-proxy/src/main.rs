// webhook-rust-proxy - Proxy reverso em Rust de alta performance para webhook-99
use std::collections::HashMap;
use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

fn load_env_file(path: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(content) = fs::read_to_string(path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some(idx) = trimmed.find('=') {
                if idx > 0 {
                    let key = trimmed[..idx].trim().to_string();
                    let val = trimmed[idx + 1..]
                        .trim()
                        .trim_matches(|c| c == '"' || c == '\'')
                        .to_string();
                    map.insert(key, val);
                }
            }
        }
    }
    map
}

fn load_config() -> HashMap<String, String> {
    let mut cfg = HashMap::new();
    let mut candidates = vec![
        PathBuf::from("../.env"),
        PathBuf::from(".env"),
        PathBuf::from("rust-proxy/.env"),
    ];
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("../.env"));
            candidates.push(dir.join(".env"));
        }
    }
    for p in candidates {
        for (k, v) in load_env_file(&p) {
            cfg.insert(k, v);
        }
    }
    cfg
}

fn get_env(cfg: &HashMap<String, String>, key: &str, fallback: &str) -> String {
    if let Ok(v) = env::var(key) {
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(v) = cfg.get(key) {
        if !v.is_empty() {
            return v.clone();
        }
    }
    fallback.to_string()
}

fn parse_backend_host_port(url_str: &str) -> (String, String) {
    let stripped = url_str
        .strip_prefix("http://")
        .or_else(|| url_str.strip_prefix("https://"))
        .unwrap_or(url_str);
    let host_port = stripped.split('/').next().unwrap_or("127.0.0.1:8080");
    if host_port.contains(':') {
        (host_port.to_string(), host_port.to_string())
    } else {
        (format!("{}:80", host_port), host_port.to_string())
    }
}

fn normalize_ip(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(stripped) = trimmed.strip_prefix("::ffff:") {
        return stripped.to_string();
    }
    trimmed.to_string()
}

struct ProxyConfig {
    _listen_port: u16,
    backend_addr: String,
    backend_host: String,
    unix_socket: String,
    max_body_size: usize,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg_map = load_config();
    let proxy_port_str = get_env(&cfg_map, "PROXY_PORT", "8081");
    let proxy_port: u16 = proxy_port_str.parse().unwrap_or(8081);

    let backend_url = get_env(&cfg_map, "BUN_BACKEND_URL", "http://127.0.0.1:8080");
    let (backend_addr, backend_host) = parse_backend_host_port(&backend_url);
    let unix_socket = get_env(&cfg_map, "BUN_UNIX_SOCKET", "");
    let max_body_size: usize = get_env(&cfg_map, "MAX_BODY_SIZE", "10485760")
        .parse()
        .unwrap_or(10 * 1024 * 1024);

    let config = Arc::new(ProxyConfig {
        _listen_port: proxy_port,
        backend_addr,
        backend_host,
        unix_socket,
        max_body_size,
    });

    let addr = SocketAddr::from(([0, 0, 0, 0], proxy_port));
    let listener = TcpListener::bind(addr).await?;
    println!(
        "__PROXY_LOG__|200|[Rust Proxy] Webhook proxy iniciado na porta {} -> Backend: {} (unix: '{}')",
        proxy_port, config.backend_addr, config.unix_socket
    );

    loop {
        let (stream, peer_addr) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[Rust Proxy] Erro no accept: {}", e);
                continue;
            }
        };

        let cfg = Arc::clone(&config);
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, peer_addr, cfg).await {
                if !e.is_empty() {
                    eprintln!("[Rust Proxy] Conexao encerrada: {}", e);
                }
            }
        });
    }
}

async fn handle_connection(
    mut client_stream: TcpStream,
    peer_addr: SocketAddr,
    cfg: Arc<ProxyConfig>,
) -> Result<(), String> {
    let _ = client_stream.set_nodelay(true);
    let client_ip = normalize_ip(&peer_addr.ip().to_string());
    let mut read_buf = vec![0u8; 65536];
    let mut unconsumed_data = Vec::new();

    loop {
        let (hdr_end, total_header_data) = match read_headers_until_delimiter(
            &mut client_stream,
            &mut read_buf,
            &mut unconsumed_data,
        )
        .await
        {
            Ok(Some(v)) => v,
            Ok(None) => break,
            Err(e) => return Err(e),
        };

        let req_start = Instant::now();
        let header_bytes = &total_header_data[..hdr_end];
        let post_header_data = &total_header_data[hdr_end + 4..];

        let header_str = match std::str::from_utf8(header_bytes) {
            Ok(s) => s,
            Err(_) => {
                let _ = send_simple_error(
                    &mut client_stream,
                    400,
                    "Bad Request",
                    "Invalid UTF-8 in headers",
                )
                .await;
                break;
            }
        };

        let mut lines = header_str.lines();
        let request_line = match lines.next() {
            Some(l) if !l.is_empty() => l,
            _ => break,
        };

        let mut req_parts = request_line.split_whitespace();
        let method = req_parts.next().unwrap_or("GET").to_uppercase();
        let path = req_parts.next().unwrap_or("/").to_string();
        let _version = req_parts.next().unwrap_or("HTTP/1.1");

        let mut content_length: Option<usize> = None;
        let mut is_chunked = false;
        let mut keep_alive = true;
        let mut headers_to_forward = Vec::new();
        let mut x_forwarded_for: Option<String> = None;

        for line in lines {
            if let Some((name, val)) = line.split_once(':') {
                let name_trim = name.trim();
                let name_lower = name_trim.to_ascii_lowercase();
                let val_trim = val.trim();

                if name_lower == "content-length" {
                    if let Ok(len) = val_trim.parse::<usize>() {
                        content_length = Some(len);
                    }
                } else if name_lower == "transfer-encoding" {
                    if val_trim.to_ascii_lowercase().contains("chunked") {
                        is_chunked = true;
                    }
                } else if name_lower == "connection" {
                    if val_trim.eq_ignore_ascii_case("close") {
                        keep_alive = false;
                    }
                } else if name_lower == "x-forwarded-for" {
                    x_forwarded_for = Some(val_trim.to_string());
                } else if name_lower == "x-real-ip" || name_lower == "host" {
                    // Substituiremos com os valores adequados
                } else {
                    headers_to_forward.push((name_trim.to_string(), val_trim.to_string()));
                }
            }
        }

        // Leitura do corpo (body)
        let mut body = Vec::new();
        if let Some(len) = content_length {
            if len > cfg.max_body_size {
                let _ = send_simple_error(
                    &mut client_stream,
                    413,
                    "Payload Too Large",
                    "Request body exceeds maximum allowed size",
                )
                .await;
                break;
            }

            body.reserve(len);
            let from_post = std::cmp::min(post_header_data.len(), len);
            body.extend_from_slice(&post_header_data[..from_post]);
            let remaining_in_post = &post_header_data[from_post..];
            unconsumed_data = remaining_in_post.to_vec();

            let mut needed = len - from_post;
            while needed > 0 {
                let to_read = std::cmp::min(needed, read_buf.len());
                let n = match timeout(
                    Duration::from_secs(30),
                    client_stream.read(&mut read_buf[..to_read]),
                )
                .await
                {
                    Ok(Ok(n)) if n > 0 => n,
                    _ => {
                        return Err("timeout ou EOF prematuro ao ler corpo da requisicao".to_string());
                    }
                };
                body.extend_from_slice(&read_buf[..n]);
                needed -= n;
            }
        } else if is_chunked {
            let (chunked_body, remaining) = match read_chunked_body(
                post_header_data,
                &mut client_stream,
                &mut read_buf,
                cfg.max_body_size,
            )
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    let _ = send_simple_error(&mut client_stream, 400, "Bad Request", &e).await;
                    break;
                }
            };
            body = chunked_body;
            unconsumed_data = remaining;
        } else {
            unconsumed_data = post_header_data.to_vec();
        }

        let final_xfwd = match x_forwarded_for {
            Some(prev) if !prev.is_empty() => format!("{}, {}", prev, client_ip),
            _ => client_ip.clone(),
        };

        // Encaminhamento ao backend (Bun)
        let forward_result = forward_to_backend(
            &cfg,
            &method,
            &path,
            &headers_to_forward,
            &final_xfwd,
            &client_ip,
            &body,
        )
        .await;

        let elapsed = req_start.elapsed().as_secs_f64() * 1000.0;

        match forward_result {
            Ok((status, resp_headers, resp_body)) => {
                let resp_str = format!(
                    "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: {}\r\n",
                    status,
                    status_text(status),
                    resp_body.len(),
                    if keep_alive { "keep-alive" } else { "close" }
                );
                let mut full_resp = Vec::with_capacity(resp_str.len() + 128 + resp_body.len());
                full_resp.extend_from_slice(resp_str.as_bytes());

                for (hn, hv) in resp_headers {
                    let hl = hn.to_ascii_lowercase();
                    if hl != "content-length" && hl != "connection" {
                        full_resp.extend_from_slice(format!("{}: {}\r\n", hn, hv).as_bytes());
                    }
                }
                full_resp.extend_from_slice(b"\r\n");
                full_resp.extend_from_slice(&resp_body);

                if let Err(e) = client_stream.write_all(&full_resp).await {
                    return Err(format!("falha ao responder cliente: {}", e));
                }

                println!(
                    "__PROXY_LOG__|{}|{} {} {} - {:.2}ms - {}",
                    status, method, path, status, elapsed, client_ip
                );
            }
            Err(e) => {
                let err_msg = format!("Falha na comunicacao com o servidor de webhook: {}", e);
                let _ = send_simple_error(&mut client_stream, 502, "Bad Gateway", &err_msg).await;
                println!(
                    "__PROXY_LOG__|502|{} {} 502 - {:.2}ms - {} ({})",
                    method, path, elapsed, client_ip, e
                );
                break;
            }
        }

        if !keep_alive {
            break;
        }
    }

    Ok(())
}

async fn read_headers_until_delimiter(
    stream: &mut TcpStream,
    buf: &mut [u8],
    unconsumed: &mut Vec<u8>,
) -> Result<Option<(usize, Vec<u8>)>, String> {
    let mut total = std::mem::take(unconsumed);

    loop {
        if let Some(pos) = total.windows(4).position(|w| w == b"\r\n\r\n") {
            return Ok(Some((pos, total)));
        }

        let n = match timeout(Duration::from_secs(60), stream.read(buf)).await {
            Ok(Ok(n)) if n > 0 => n,
            Ok(Ok(_)) => {
                if total.is_empty() {
                    return Ok(None);
                }
                return Err("EOF inesperado lendo headers".to_string());
            }
            Ok(Err(e)) => return Err(format!("erro de socket: {}", e)),
            Err(_) => return Ok(None),
        };

        total.extend_from_slice(&buf[..n]);

        if total.len() > 65536 {
            return Err("headers excedem o limite de 64KB".to_string());
        }
    }
}

async fn read_chunked_body(
    initial_data: &[u8],
    stream: &mut TcpStream,
    buf: &mut [u8],
    max_size: usize,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut raw_stream = initial_data.to_vec();
    let mut decoded = Vec::new();
    let mut pos = 0;

    loop {
        let rest = &raw_stream[pos..];
        if let Some(crlf) = rest.windows(2).position(|w| w == b"\r\n") {
            let line = std::str::from_utf8(&rest[..crlf])
                .map_err(|_| "chunk size invalido".to_string())?
                .trim();
            let size_str = line.split(';').next().unwrap_or("0").trim();
            let chunk_size = usize::from_str_radix(size_str, 16)
                .map_err(|_| "hex chunk size invalido".to_string())?;

            if chunk_size == 0 {
                let term_pos = pos + crlf + 4;
                let remaining = if term_pos < raw_stream.len() {
                    raw_stream[term_pos..].to_vec()
                } else {
                    Vec::new()
                };
                return Ok((decoded, remaining));
            }

            let data_start = pos + crlf + 2;
            let data_end = data_start + chunk_size;

            while raw_stream.len() < data_end + 2 {
                let n = match timeout(Duration::from_secs(30), stream.read(buf)).await {
                    Ok(Ok(n)) if n > 0 => n,
                    _ => return Err("EOF prematuro no corpo chunked".to_string()),
                };
                raw_stream.extend_from_slice(&buf[..n]);
            }

            if decoded.len() + chunk_size > max_size {
                return Err("corpo chunked excede tamanho maximo".to_string());
            }

            decoded.extend_from_slice(&raw_stream[data_start..data_end]);
            pos = data_end + 2;
        } else {
            let n = match timeout(Duration::from_secs(30), stream.read(buf)).await {
                Ok(Ok(n)) if n > 0 => n,
                _ => return Err("EOF prematuro aguardando chunk".to_string()),
            };
            raw_stream.extend_from_slice(&buf[..n]);
        }
    }
}

async fn forward_to_backend(
    cfg: &ProxyConfig,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    x_fwd: &str,
    client_ip: &str,
    body: &[u8],
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    let mut req_header = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nX-Forwarded-For: {}\r\nX-Real-IP: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        method, path, cfg.backend_host, x_fwd, client_ip, body.len()
    );

    for (hn, hv) in headers {
        req_header.push_str(&format!("{}: {}\r\n", hn, hv));
    }
    req_header.push_str("\r\n");

    let mut send_payload = Vec::with_capacity(req_header.len() + body.len());
    send_payload.extend_from_slice(req_header.as_bytes());
    send_payload.extend_from_slice(body);

    #[cfg(unix)]
    if !cfg.unix_socket.is_empty() && Path::new(&cfg.unix_socket).exists() {
        if let Ok(Ok(mut ustream)) = timeout(
            Duration::from_secs(10),
            tokio::net::UnixStream::connect(&cfg.unix_socket),
        )
        .await
        {
            ustream
                .write_all(&send_payload)
                .await
                .map_err(|e| e.to_string())?;
            let mut raw_resp = Vec::with_capacity(65536);
            ustream
                .read_to_end(&mut raw_resp)
                .await
                .map_err(|e| e.to_string())?;
            return parse_backend_response(&raw_resp);
        }
    }

    let mut backend_stream = timeout(
        Duration::from_secs(10),
        TcpStream::connect(&cfg.backend_addr),
    )
    .await
    .map_err(|_| "timeout ao conectar ao backend Bun".to_string())?
    .map_err(|e| format!("erro ao conectar ao backend {}: {}", cfg.backend_addr, e))?;

    let _ = backend_stream.set_nodelay(true);
    backend_stream
        .write_all(&send_payload)
        .await
        .map_err(|e| format!("erro ao enviar requisicao ao backend: {}", e))?;

    let mut raw_resp = Vec::with_capacity(65536);
    backend_stream
        .read_to_end(&mut raw_resp)
        .await
        .map_err(|e| format!("erro ao ler resposta do backend: {}", e))?;

    parse_backend_response(&raw_resp)
}

fn parse_backend_response(raw: &[u8]) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    let hdr_end = match raw.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(pos) => pos,
        None => return Err("resposta invalida do backend Bun (sem delimitador HTTP)".to_string()),
    };

    let hdr_bytes = &raw[..hdr_end];
    let body_bytes = &raw[hdr_end + 4..];
    let hdr_str = String::from_utf8_lossy(hdr_bytes);
    let mut lines = hdr_str.lines();

    let status_line = lines.next().unwrap_or("HTTP/1.1 502 Bad Gateway");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(502);

    let is_chunked = hdr_str
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");

    let body = if is_chunked {
        decode_chunked_response(body_bytes)
    } else {
        body_bytes.to_vec()
    };

    let mut resp_headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let kl = k.trim().to_ascii_lowercase();
            if kl != "connection" && kl != "transfer-encoding" && kl != "content-length" {
                resp_headers.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
    }

    Ok((status, resp_headers, body))
}

fn decode_chunked_response(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut pos = 0;
    while pos < input.len() {
        let rest = &input[pos..];
        let Some(line_end) = rest.windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_str = std::str::from_utf8(&rest[..line_end])
            .unwrap_or("0")
            .split(';')
            .next()
            .unwrap_or("0")
            .trim();
        let Ok(chunk_size) = usize::from_str_radix(size_str, 16) else {
            break;
        };
        if chunk_size == 0 {
            break;
        }
        let data_start = pos + line_end + 2;
        if data_start + chunk_size > input.len() {
            out.extend_from_slice(&input[data_start..]);
            break;
        }
        out.extend_from_slice(&input[data_start..data_start + chunk_size]);
        pos = data_start + chunk_size + 2;
    }
    out
}

async fn send_simple_error(
    stream: &mut TcpStream,
    status: u16,
    status_text_str: &str,
    msg: &str,
) -> Result<(), String> {
    let escaped_msg = msg.replace('\\', "\\\\").replace('"', "\\\"");
    let body = format!(
        "{{\"status\":{},\"error\":\"{}\",\"message\":\"{}\"}}\n",
        status, status_text_str, escaped_msg
    );
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        status_text_str,
        body.len(),
        body
    );
    stream
        .write_all(resp.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}
