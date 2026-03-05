#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use url::Url;
use wreq::header::{HeaderMap, HeaderName, HeaderValue};
use wreq::Client;
use wreq_util::{Emulation, EmulationOS, EmulationOption};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    app_version: String,
    platform: String,
    app_data_dir: String,
    app_log_dir: String,
}

#[tauri::command]
fn runtime_info(app: tauri::AppHandle) -> RuntimeInfo {
    let version = app.package_info().version.to_string();
    let platform = std::env::consts::OS.to_string();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let app_log_dir = app
        .path()
        .app_log_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    RuntimeInfo {
        app_version: version,
        platform,
        app_data_dir,
        app_log_dir,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TlsImageFetchResponse {
    status: u16,
    content_type: String,
    final_url: String,
    body: Vec<u8>,
    profile: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadImageResponse {
    path: String,
    file_name: String,
    bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoragePaths {
    root_path: String,
    data_path: String,
    db_path: String,
    image_cache_path: String,
}

#[derive(Serialize, Deserialize, Default)]
struct GatewayConfigToml {
    #[serde(default)]
    gateway: GatewayConfigTomlSection,
    #[serde(default)]
    appearance: AppearanceConfigTomlSection,
    #[serde(default)]
    recovery: RecoveryConfigTomlSection,
}

#[derive(Serialize, Deserialize, Default)]
struct GatewayConfigTomlSection {
    #[serde(default)]
    api_base_url: String,
    #[serde(default)]
    api_key: String,
}

#[derive(Serialize, Deserialize, Default)]
struct AppearanceConfigTomlSection {
    #[serde(default)]
    theme: String,
    #[serde(default)]
    font_size: String,
}

#[derive(Serialize, Deserialize, Default)]
struct RecoveryConfigTomlSection {
    #[serde(default)]
    turn_in_progress_retry_max_attempts: Option<u32>,
    #[serde(default)]
    turn_in_progress_retry_delay_ms: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayConfigPayload {
    api_base_url: String,
    api_key: String,
    theme: String,
    font_size: String,
    turn_in_progress_retry_max_attempts: u32,
    turn_in_progress_retry_delay_ms: u64,
    config_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppearanceConfigPayload {
    theme: String,
    font_size: String,
    config_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageCacheStats {
    root_path: String,
    items: usize,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageCacheClearResult {
    root_path: String,
    cleared_items: usize,
    cleared_bytes: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageCacheMeta {
    source_key: String,
    final_url: String,
    content_type: String,
    cached_at_ms: u64,
    ttl_seconds: u64,
}

const IMAGE_CACHE_DEFAULT_TTL_SECONDS: u64 = 24 * 60 * 60;
const IMAGE_CACHE_MIN_TTL_SECONDS: u64 = 60;
const IMAGE_CACHE_MAX_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;

fn host_emulation_os() -> EmulationOS {
    match std::env::consts::OS {
        "windows" => EmulationOS::Windows,
        "linux" => EmulationOS::Linux,
        "android" => EmulationOS::Android,
        "ios" => EmulationOS::IOS,
        _ => EmulationOS::MacOS,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve_nbsearch_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("resolve home dir failed: {e}"))?;
    let root = home.join(".nbsearch");
    fs::create_dir_all(&root).map_err(|e| format!("create nbsearch root failed: {e}"))?;
    Ok(root)
}

fn resolve_image_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_nbsearch_root(app)?.join("cache").join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("create image cache dir failed: {e}"))?;
    Ok(dir)
}

fn resolve_nbsearch_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_nbsearch_root(app)?.join("data");
    fs::create_dir_all(&dir).map_err(|e| format!("create nbsearch data dir failed: {e}"))?;
    Ok(dir)
}

fn resolve_nbsearch_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_nbsearch_data_dir(app)?.join("chat-app.db"))
}

fn resolve_app_config_toml_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_nbsearch_root(app)?;
    Ok(root.join("config.toml"))
}

fn read_gateway_config_toml(path: &Path) -> Result<GatewayConfigToml, String> {
    if !path.exists() {
        return Ok(GatewayConfigToml::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read config.toml failed: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(GatewayConfigToml::default());
    }
    toml::from_str::<GatewayConfigToml>(&raw).map_err(|e| format!("parse config.toml failed: {e}"))
}

fn write_gateway_config_toml(path: &Path, config: &GatewayConfigToml) -> Result<(), String> {
    let encoded =
        toml::to_string_pretty(config).map_err(|e| format!("encode config.toml failed: {e}"))?;
    fs::write(path, encoded).map_err(|e| format!("write config.toml failed: {e}"))?;
    Ok(())
}

fn normalize_theme_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "dark" => "dark".to_string(),
        "system" => "system".to_string(),
        _ => "light".to_string(),
    }
}

fn normalize_font_size_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "small" => "small".to_string(),
        "large" => "large".to_string(),
        _ => "default".to_string(),
    }
}

const TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS_DEFAULT: u32 = 1;
const TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS_MAX: u32 = 10;
const TURN_IN_PROGRESS_RETRY_DELAY_MS_DEFAULT: u64 = 600;
const TURN_IN_PROGRESS_RETRY_DELAY_MS_MAX: u64 = 30_000;

fn normalize_turn_in_progress_retry_max_attempts(value: Option<u32>) -> u32 {
    value
        .map(|v| v.min(TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS_MAX))
        .unwrap_or(TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS_DEFAULT)
}

fn normalize_turn_in_progress_retry_delay_ms(value: Option<u64>) -> u64 {
    value
        .map(|v| v.min(TURN_IN_PROGRESS_RETRY_DELAY_MS_MAX))
        .unwrap_or(TURN_IN_PROGRESS_RETRY_DELAY_MS_DEFAULT)
}

fn canonicalize_image_cache_key(url: &str) -> String {
    let trimmed = url.trim();
    if let Ok(parsed) = Url::parse(trimmed) {
        let Some(host) = parsed.host_str() else {
            return trimmed.to_string();
        };

        let mut canonical = String::with_capacity(trimmed.len() + 16);
        canonical.push_str(parsed.scheme());
        canonical.push_str("://");
        canonical.push_str(&host.to_ascii_lowercase());

        if let Some(port) = parsed.port() {
            let is_default_port = (parsed.scheme() == "http" && port == 80)
                || (parsed.scheme() == "https" && port == 443);
            if !is_default_port {
                canonical.push(':');
                canonical.push_str(&port.to_string());
            }
        }

        let path = parsed.path();
        if path.is_empty() {
            canonical.push('/');
        } else {
            canonical.push_str(path);
        }

        if let Some(query) = parsed.query() {
            canonical.push('?');
            canonical.push_str(query);
        }

        canonical
    } else {
        trimmed.to_string()
    }
}

fn image_cache_hash_key(url: &str) -> String {
    let canonical = canonicalize_image_cache_key(url);
    let digest = Sha256::digest(format!("v2|{canonical}").as_bytes());
    format!("{digest:x}")
}

fn image_cache_paths(cache_dir: &Path, key: &str) -> (PathBuf, PathBuf) {
    let body_path = cache_dir.join(format!("{key}.bin"));
    let meta_path = cache_dir.join(format!("{key}.json"));
    (body_path, meta_path)
}

fn read_image_cache(
    body_path: &Path,
    meta_path: &Path,
    now: u64,
) -> Result<Option<(ImageCacheMeta, Vec<u8>)>, String> {
    if !body_path.exists() || !meta_path.exists() {
        return Ok(None);
    }

    let meta_bytes =
        fs::read(meta_path).map_err(|e| format!("read image cache meta failed: {e}"))?;
    let meta: ImageCacheMeta = serde_json::from_slice(&meta_bytes)
        .map_err(|e| format!("parse image cache meta failed: {e}"))?;

    let expires_at = meta
        .cached_at_ms
        .saturating_add(meta.ttl_seconds.saturating_mul(1000));
    if expires_at <= now {
        let _ = fs::remove_file(body_path);
        let _ = fs::remove_file(meta_path);
        return Ok(None);
    }

    let body = fs::read(body_path).map_err(|e| format!("read image cache body failed: {e}"))?;
    if body.is_empty() {
        let _ = fs::remove_file(body_path);
        let _ = fs::remove_file(meta_path);
        return Ok(None);
    }

    Ok(Some((meta, body)))
}

fn write_image_cache(
    body_path: &Path,
    meta_path: &Path,
    body: &[u8],
    meta: &ImageCacheMeta,
) -> Result<(), String> {
    fs::write(body_path, body).map_err(|e| format!("write image cache body failed: {e}"))?;
    let meta_json =
        serde_json::to_vec(meta).map_err(|e| format!("encode image cache meta failed: {e}"))?;
    fs::write(meta_path, meta_json).map_err(|e| format!("write image cache meta failed: {e}"))?;
    Ok(())
}

fn compute_image_cache_stats(cache_dir: &Path) -> Result<(usize, u64), String> {
    if !cache_dir.exists() {
        return Ok((0, 0));
    }

    let mut items: usize = 0;
    let mut bytes: u64 = 0;
    let entries =
        fs::read_dir(cache_dir).map_err(|e| format!("read image cache dir failed: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read image cache entry failed: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or_default();
        if ext.eq_ignore_ascii_case("bin") {
            items = items.saturating_add(1);
            let metadata = entry
                .metadata()
                .map_err(|e| format!("read image cache entry metadata failed: {e}"))?;
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok((items, bytes))
}

fn build_header_map(raw: Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    let Some(raw_headers) = raw else {
        return Ok(headers);
    };

    for (name_raw, value_raw) in raw_headers {
        let trimmed_name = name_raw.trim();
        let trimmed_value = value_raw.trim();
        if trimmed_name.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        let name = HeaderName::from_bytes(trimmed_name.as_bytes())
            .map_err(|e| format!("invalid header name {name_raw}: {e}"))?;
        let value = HeaderValue::from_str(trimmed_value)
            .map_err(|e| format!("invalid header value for {name}: {e}"))?;
        headers.insert(name, value);
    }

    Ok(headers)
}

fn sanitize_file_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '(' | ')' | ' ') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "image.jpg".to_string()
    } else {
        trimmed
    }
}

fn content_type_to_ext(content_type: &str) -> &'static str {
    let lower = content_type.to_ascii_lowercase();
    if lower.contains("image/png") {
        "png"
    } else if lower.contains("image/webp") {
        "webp"
    } else if lower.contains("image/gif") {
        "gif"
    } else if lower.contains("image/avif") {
        "avif"
    } else if lower.contains("image/svg") {
        "svg"
    } else if lower.contains("image/bmp") {
        "bmp"
    } else {
        "jpg"
    }
}

fn with_extension_if_missing(file_name: &str, ext: &str) -> String {
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
        || lower.ends_with(".avif")
        || lower.ends_with(".svg")
        || lower.ends_with(".bmp")
    {
        file_name.to_string()
    } else {
        format!("{file_name}.{ext}")
    }
}

fn sanitize_unicode_file_name(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_control() {
            continue;
        }
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn with_pdf_extension_if_missing(file_name: &str) -> String {
    if file_name.to_ascii_lowercase().ends_with(".pdf") {
        file_name.to_string()
    } else {
        format!("{file_name}.pdf")
    }
}

fn unique_destination_path(base_dir: PathBuf, file_name: &str) -> PathBuf {
    let initial = base_dir.join(file_name);
    if !initial.exists() {
        return initial;
    }

    let stem = initial
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string();
    let ext = initial
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();

    for idx in 1..=9999 {
        let candidate_name = if ext.is_empty() {
            format!("{stem} ({idx})")
        } else {
            format!("{stem} ({idx}).{ext}")
        };
        let candidate = base_dir.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    initial
}

#[tauri::command(rename_all = "camelCase")]
fn save_pdf_document(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    file_name: Option<String>,
    destination_path: Option<String>,
) -> Result<DownloadImageResponse, String> {
    if bytes.is_empty() {
        return Err("empty pdf bytes".to_string());
    }

    let suggested = file_name.unwrap_or_else(|| "conversation.pdf".to_string());
    let cleaned = sanitize_unicode_file_name(&suggested, "conversation.pdf");
    let with_ext = with_pdf_extension_if_missing(&cleaned);

    let destination = if let Some(raw_path) = destination_path {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Err("empty destination path".to_string());
        }
        let mut candidate = PathBuf::from(trimmed);
        if candidate.extension().is_none() {
            candidate.set_extension("pdf");
        }
        candidate
    } else {
        let downloads_dir = app
            .path()
            .download_dir()
            .or_else(|_| app.path().desktop_dir())
            .or_else(|_| app.path().home_dir())
            .map_err(|e| format!("resolve downloads dir failed: {e}"))?;
        unique_destination_path(downloads_dir, &with_ext)
    };

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("prepare destination dir failed: {e}"))?;
    }
    fs::write(&destination, &bytes).map_err(|e| format!("write pdf failed: {e}"))?;

    Ok(DownloadImageResponse {
        path: destination.to_string_lossy().to_string(),
        file_name: destination
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("conversation.pdf")
            .to_string(),
        bytes: bytes.len(),
    })
}

#[tauri::command]
async fn fetch_image_with_tls_profile(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<TlsImageFetchResponse, String> {
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        return Err("empty url".to_string());
    }

    let emulation = EmulationOption::builder()
        .emulation(Emulation::Chrome145)
        .emulation_os(host_emulation_os())
        .build();

    let mut builder = Client::builder()
        .emulation(emulation)
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(20))
        .cert_verification(true);

    let header_map = build_header_map(headers)?;
    if !header_map.is_empty() {
        builder = builder.default_headers(header_map);
    }

    let client = builder
        .build()
        .map_err(|e| format!("build tls client failed: {e}"))?;
    let response = client
        .get(trimmed_url)
        .send()
        .await
        .map_err(|e| format!("tls fetch failed: {e}"))?;

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("http_{status}"));
    }

    let content_type = response
        .headers()
        .get(wreq::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let final_url = response.uri().to_string();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("read tls body failed: {e}"))?
        .to_vec();
    if body.is_empty() {
        return Err("empty_body".to_string());
    }

    Ok(TlsImageFetchResponse {
        status,
        content_type,
        final_url,
        body,
        profile: "wreq/chrome145".to_string(),
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn fetch_image_with_cache(
    app: tauri::AppHandle,
    url: String,
    headers: Option<HashMap<String, String>>,
    ttl_seconds: Option<u64>,
) -> Result<TlsImageFetchResponse, String> {
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        return Err("empty url".to_string());
    }

    let ttl = ttl_seconds
        .unwrap_or(IMAGE_CACHE_DEFAULT_TTL_SECONDS)
        .clamp(IMAGE_CACHE_MIN_TTL_SECONDS, IMAGE_CACHE_MAX_TTL_SECONDS);

    let cache_dir = resolve_image_cache_dir(&app)?;
    let key = image_cache_hash_key(trimmed_url);
    let (body_path, meta_path) = image_cache_paths(&cache_dir, &key);
    let now = now_ms();

    match read_image_cache(&body_path, &meta_path, now) {
        Ok(Some((meta, body))) => {
            return Ok(TlsImageFetchResponse {
                status: 200,
                content_type: meta.content_type,
                final_url: meta.final_url,
                body,
                profile: "cache/hit".to_string(),
            });
        }
        Ok(None) => {}
        Err(_) => {
            let _ = fs::remove_file(&body_path);
            let _ = fs::remove_file(&meta_path);
        }
    }

    let emulation = EmulationOption::builder()
        .emulation(Emulation::Chrome145)
        .emulation_os(host_emulation_os())
        .build();

    let mut builder = Client::builder()
        .emulation(emulation)
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(20))
        .cert_verification(true);

    let header_map = build_header_map(headers)?;
    if !header_map.is_empty() {
        builder = builder.default_headers(header_map);
    }

    let client = builder
        .build()
        .map_err(|e| format!("build cache fetch client failed: {e}"))?;
    let response = client
        .get(trimmed_url)
        .send()
        .await
        .map_err(|e| format!("cache fetch request failed: {e}"))?;

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("http_{status}"));
    }

    let content_type = response
        .headers()
        .get(wreq::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let final_url = response.uri().to_string();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("read cache fetch body failed: {e}"))?
        .to_vec();
    if body.is_empty() {
        return Err("empty_body".to_string());
    }

    let meta = ImageCacheMeta {
        source_key: canonicalize_image_cache_key(trimmed_url),
        final_url: final_url.clone(),
        content_type: content_type.clone(),
        cached_at_ms: now_ms(),
        ttl_seconds: ttl,
    };
    let _ = write_image_cache(&body_path, &meta_path, &body, &meta);

    Ok(TlsImageFetchResponse {
        status,
        content_type,
        final_url,
        body,
        profile: "wreq/chrome145+cache".to_string(),
    })
}

#[tauri::command]
fn get_image_cache_stats(app: tauri::AppHandle) -> Result<ImageCacheStats, String> {
    let cache_dir = resolve_image_cache_dir(&app)?;
    let (items, bytes) = compute_image_cache_stats(&cache_dir)?;
    Ok(ImageCacheStats {
        root_path: cache_dir.to_string_lossy().to_string(),
        items,
        bytes,
    })
}

#[tauri::command]
fn clear_image_cache(app: tauri::AppHandle) -> Result<ImageCacheClearResult, String> {
    let cache_dir = resolve_image_cache_dir(&app)?;
    let (cleared_items, cleared_bytes) = compute_image_cache_stats(&cache_dir)?;

    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).map_err(|e| format!("clear image cache failed: {e}"))?;
    }
    fs::create_dir_all(&cache_dir).map_err(|e| format!("recreate image cache dir failed: {e}"))?;

    Ok(ImageCacheClearResult {
        root_path: cache_dir.to_string_lossy().to_string(),
        cleared_items,
        cleared_bytes,
    })
}

#[tauri::command]
fn resolve_storage_paths(app: tauri::AppHandle) -> Result<StoragePaths, String> {
    let root = resolve_nbsearch_root(&app)?;
    let data = resolve_nbsearch_data_dir(&app)?;
    let db = resolve_nbsearch_db_path(&app)?;
    let image_cache = resolve_image_cache_dir(&app)?;

    Ok(StoragePaths {
        root_path: root.to_string_lossy().to_string(),
        data_path: data.to_string_lossy().to_string(),
        db_path: db.to_string_lossy().to_string(),
        image_cache_path: image_cache.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "camelCase")]
fn read_gateway_config(app: tauri::AppHandle) -> Result<GatewayConfigPayload, String> {
    let config_path = resolve_app_config_toml_path(&app)?;
    let parsed = read_gateway_config_toml(&config_path)?;
    Ok(GatewayConfigPayload {
        api_base_url: parsed.gateway.api_base_url.trim().to_string(),
        api_key: parsed.gateway.api_key.trim().to_string(),
        theme: normalize_theme_mode(parsed.appearance.theme.as_str()),
        font_size: normalize_font_size_mode(parsed.appearance.font_size.as_str()),
        turn_in_progress_retry_max_attempts: normalize_turn_in_progress_retry_max_attempts(
            parsed.recovery.turn_in_progress_retry_max_attempts,
        ),
        turn_in_progress_retry_delay_ms: normalize_turn_in_progress_retry_delay_ms(
            parsed.recovery.turn_in_progress_retry_delay_ms,
        ),
        config_path: config_path.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "camelCase")]
fn save_gateway_config(
    app: tauri::AppHandle,
    api_base_url: String,
    api_key: String,
) -> Result<GatewayConfigPayload, String> {
    let config_path = resolve_app_config_toml_path(&app)?;
    let mut parsed = read_gateway_config_toml(&config_path).unwrap_or_default();
    parsed.gateway.api_base_url = api_base_url.trim().to_string();
    parsed.gateway.api_key = api_key.trim().to_string();
    let normalized_retry_max_attempts = normalize_turn_in_progress_retry_max_attempts(
        parsed.recovery.turn_in_progress_retry_max_attempts,
    );
    let normalized_retry_delay_ms =
        normalize_turn_in_progress_retry_delay_ms(parsed.recovery.turn_in_progress_retry_delay_ms);
    parsed.recovery.turn_in_progress_retry_max_attempts = Some(normalized_retry_max_attempts);
    parsed.recovery.turn_in_progress_retry_delay_ms = Some(normalized_retry_delay_ms);
    write_gateway_config_toml(&config_path, &parsed)?;

    Ok(GatewayConfigPayload {
        api_base_url: parsed.gateway.api_base_url,
        api_key: parsed.gateway.api_key,
        theme: normalize_theme_mode(parsed.appearance.theme.as_str()),
        font_size: normalize_font_size_mode(parsed.appearance.font_size.as_str()),
        turn_in_progress_retry_max_attempts: normalized_retry_max_attempts,
        turn_in_progress_retry_delay_ms: normalized_retry_delay_ms,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "camelCase")]
fn save_appearance_config(
    app: tauri::AppHandle,
    theme: String,
    font_size: String,
) -> Result<AppearanceConfigPayload, String> {
    let config_path = resolve_app_config_toml_path(&app)?;
    let mut parsed = read_gateway_config_toml(&config_path).unwrap_or_default();
    parsed.appearance.theme = normalize_theme_mode(theme.as_str());
    parsed.appearance.font_size = normalize_font_size_mode(font_size.as_str());
    write_gateway_config_toml(&config_path, &parsed)?;

    Ok(AppearanceConfigPayload {
        theme: parsed.appearance.theme,
        font_size: parsed.appearance.font_size,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn download_image_to_downloads(
    app: tauri::AppHandle,
    url: String,
    file_name: Option<String>,
    destination_path: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<DownloadImageResponse, String> {
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        return Err("empty url".to_string());
    }

    let emulation = EmulationOption::builder()
        .emulation(Emulation::Chrome145)
        .emulation_os(host_emulation_os())
        .build();

    let mut builder = Client::builder()
        .emulation(emulation)
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(45))
        .cert_verification(true);

    let header_map = build_header_map(headers)?;
    if !header_map.is_empty() {
        builder = builder.default_headers(header_map);
    }

    let client = builder
        .build()
        .map_err(|e| format!("build download client failed: {e}"))?;
    let response = client
        .get(trimmed_url)
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("http_{status}"));
    }

    let content_type = response
        .headers()
        .get(wreq::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read download body failed: {e}"))?
        .to_vec();
    if bytes.is_empty() {
        return Err("empty_body".to_string());
    }

    let suggested = file_name.unwrap_or_else(|| "image.jpg".to_string());
    let cleaned = sanitize_file_name(&suggested);
    let with_ext = with_extension_if_missing(&cleaned, content_type_to_ext(&content_type));

    let destination = if let Some(raw_path) = destination_path {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Err("empty destination path".to_string());
        }
        let mut candidate = PathBuf::from(trimmed);
        if candidate.extension().is_none() {
            candidate.set_extension(content_type_to_ext(&content_type));
        }
        candidate
    } else {
        let downloads_dir = app
            .path()
            .download_dir()
            .or_else(|_| app.path().desktop_dir())
            .or_else(|_| app.path().home_dir())
            .map_err(|e| format!("resolve downloads dir failed: {e}"))?;
        unique_destination_path(downloads_dir, &with_ext)
    };

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("prepare destination dir failed: {e}"))?;
    }

    std::fs::write(&destination, &bytes).map_err(|e| format!("write file failed: {e}"))?;

    Ok(DownloadImageResponse {
        path: destination.to_string_lossy().to_string(),
        file_name: destination
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image.jpg")
            .to_string(),
        bytes: bytes.len(),
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            resolve_storage_paths,
            read_gateway_config,
            save_gateway_config,
            save_appearance_config,
            fetch_image_with_tls_profile,
            fetch_image_with_cache,
            get_image_cache_stats,
            clear_image_cache,
            download_image_to_downloads,
            save_pdf_document
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
