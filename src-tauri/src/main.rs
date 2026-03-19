#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tray_icon_rgba;

use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_updater::UpdaterExt;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientLogPayload {
    level: String,
    scope: String,
    message: String,
    context: Option<serde_json::Value>,
}

const NBSEARCH_UPDATER_ENDPOINT: Option<&str> = option_env!("NBSEARCH_UPDATER_ENDPOINT");
const NBSEARCH_UPDATER_ENDPOINTS: Option<&str> = option_env!("NBSEARCH_UPDATER_ENDPOINTS");
const NBSEARCH_UPDATER_PUBKEY: Option<&str> = option_env!("NBSEARCH_UPDATER_PUBKEY");

#[derive(Clone)]
struct UpdaterRuntimeConfig {
    pubkey: String,
    endpoints: Vec<Url>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateCheckResponse {
    enabled: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    pub_date: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInstallResponse {
    enabled: bool,
    installed: bool,
    current_version: String,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdatePrepareResponse {
    enabled: bool,
    available: bool,
    downloaded: bool,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    pub_date: Option<String>,
    error: Option<String>,
}

struct PreparedAppUpdate {
    current_version: String,
    version: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct PreparedAppUpdateState {
    update: Mutex<Option<PreparedAppUpdate>>,
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

fn resolve_app_log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("resolve app log dir failed: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app log dir failed: {e}"))?;
    Ok(dir)
}

#[tauri::command]
fn append_client_log(app: tauri::AppHandle, payload: ClientLogPayload) -> Result<(), String> {
    let log_path = resolve_app_log_dir(&app)?.join("frontend.log");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open frontend log failed: {e}"))?;

    let line = serde_json::json!({
        "ts_ms": now_ms(),
        "level": payload.level.trim(),
        "scope": payload.scope.trim(),
        "message": payload.message.trim(),
        "context": payload.context.unwrap_or(serde_json::Value::Null),
    });

    writeln!(file, "{}", line).map_err(|e| format!("write frontend log failed: {e}"))?;
    Ok(())
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
    llm: LlmConfigTomlSection,
    #[serde(default)]
    appearance: AppearanceConfigTomlSection,
    #[serde(default)]
    personalization: PersonalizationConfigTomlSection,
    #[serde(default)]
    subscriptions: SubscriptionsConfigTomlSection,
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
struct LlmConfigTomlSection {
    #[serde(default)]
    api_base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    translation_model: String,
}

#[derive(Serialize, Deserialize, Default)]
struct AppearanceConfigTomlSection {
    #[serde(default)]
    theme: String,
    #[serde(default)]
    font_size: String,
}

#[derive(Serialize, Deserialize, Default)]
struct PersonalizationConfigTomlSection {
    #[serde(default)]
    timezone: String,
}

#[derive(Serialize, Deserialize, Default)]
struct SubscriptionsConfigTomlSection {
    #[serde(default)]
    polymarket_enabled: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct RecoveryConfigTomlSection {
    #[serde(default)]
    stream_idle_timeout_ms: Option<u64>,
    #[serde(default)]
    stream_idle_retry_max_attempts: Option<u32>,
    #[serde(default)]
    stream_idle_retry_delay_ms: Option<u64>,
    #[serde(default)]
    turn_recovery_messages_limit: Option<u32>,
    #[serde(default)]
    turn_recovery_not_found_retry_max_attempts: Option<u32>,
    #[serde(default)]
    turn_recovery_poll_in_progress_max_attempts: Option<u32>,
    #[serde(default)]
    turn_recovery_poll_in_progress_delay_ms: Option<u64>,
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
    llm_api_base_url: String,
    llm_api_key: String,
    llm_translation_model: String,
    theme: String,
    font_size: String,
    timezone: String,
    polymarket_enabled: bool,
    stream_idle_timeout_ms: u64,
    stream_idle_retry_max_attempts: u32,
    stream_idle_retry_delay_ms: u64,
    turn_recovery_messages_limit: u32,
    turn_recovery_not_found_retry_max_attempts: u32,
    turn_recovery_poll_in_progress_max_attempts: u32,
    turn_recovery_poll_in_progress_delay_ms: u64,
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmConfigPayload {
    llm_api_base_url: String,
    llm_api_key: String,
    llm_translation_model: String,
    config_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonalizationConfigPayload {
    timezone: String,
    config_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionsConfigPayload {
    polymarket_enabled: bool,
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

fn normalize_timezone(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "Asia/Shanghai".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_llm_api_base_url(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "https://cpabak.zeabur.app/v1".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_llm_translation_model(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "gpt-5.4-mini".to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_updater_runtime_config() -> Result<Option<UpdaterRuntimeConfig>, String> {
    let pubkey = NBSEARCH_UPDATER_PUBKEY
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let Some(pubkey) = pubkey else {
        return Ok(None);
    };

    let mut endpoints: Vec<Url> = Vec::new();
    if let Some(raw) = NBSEARCH_UPDATER_ENDPOINTS {
        for candidate in raw.split(|ch| matches!(ch, ',' | '\n' | ';')) {
            let trimmed = candidate.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed = Url::parse(trimmed)
                .map_err(|e| format!("invalid updater endpoint {trimmed}: {e}"))?;
            endpoints.push(parsed);
        }
    }
    if endpoints.is_empty() {
        if let Some(raw) = NBSEARCH_UPDATER_ENDPOINT {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                let parsed = Url::parse(trimmed)
                    .map_err(|e| format!("invalid updater endpoint {trimmed}: {e}"))?;
                endpoints.push(parsed);
            }
        }
    }

    if endpoints.is_empty() {
        return Ok(None);
    }

    Ok(Some(UpdaterRuntimeConfig { pubkey, endpoints }))
}

fn build_runtime_updater(
    app: &tauri::AppHandle,
) -> Result<Option<tauri_plugin_updater::Updater>, String> {
    let Some(config) = resolve_updater_runtime_config()? else {
        return Ok(None);
    };

    let builder = app.updater_builder().pubkey(config.pubkey);
    let builder = builder
        .endpoints(config.endpoints)
        .map_err(|e| format!("configure updater endpoints failed: {e}"))?;
    let updater = builder
        .build()
        .map_err(|e| format!("build updater failed: {e}"))?;

    Ok(Some(updater))
}

const STREAM_IDLE_TIMEOUT_MS_DEFAULT: u64 = 20_000;
const STREAM_IDLE_TIMEOUT_MS_MAX: u64 = 120_000;
const STREAM_IDLE_RETRY_MAX_ATTEMPTS_DEFAULT: u32 = 1;
const STREAM_IDLE_RETRY_MAX_ATTEMPTS_MAX: u32 = 10;
const STREAM_IDLE_RETRY_DELAY_MS_DEFAULT: u64 = 450;
const STREAM_IDLE_RETRY_DELAY_MS_MAX: u64 = 30_000;
const TURN_RECOVERY_MESSAGES_LIMIT_DEFAULT: u32 = 100;
const TURN_RECOVERY_MESSAGES_LIMIT_MAX: u32 = 500;
const TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS_DEFAULT: u32 = 1;
const TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS_MAX: u32 = 10;
const TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS_DEFAULT: u32 = 2;
const TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS_MAX: u32 = 20;
const TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS_DEFAULT: u64 = 700;
const TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS_MAX: u64 = 30_000;
const TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS_DEFAULT: u32 = 1;
const TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS_MAX: u32 = 10;
const TURN_IN_PROGRESS_RETRY_DELAY_MS_DEFAULT: u64 = 600;
const TURN_IN_PROGRESS_RETRY_DELAY_MS_MAX: u64 = 30_000;

fn normalize_u32(value: Option<u32>, default_value: u32, max_value: u32) -> u32 {
    value.map(|v| v.min(max_value)).unwrap_or(default_value)
}

fn normalize_u64(value: Option<u64>, default_value: u64, max_value: u64) -> u64 {
    value.map(|v| v.min(max_value)).unwrap_or(default_value)
}

fn normalize_stream_idle_timeout_ms(value: Option<u64>) -> u64 {
    normalize_u64(
        value,
        STREAM_IDLE_TIMEOUT_MS_DEFAULT,
        STREAM_IDLE_TIMEOUT_MS_MAX,
    )
}

fn normalize_stream_idle_retry_max_attempts(value: Option<u32>) -> u32 {
    normalize_u32(
        value,
        STREAM_IDLE_RETRY_MAX_ATTEMPTS_DEFAULT,
        STREAM_IDLE_RETRY_MAX_ATTEMPTS_MAX,
    )
}

fn normalize_stream_idle_retry_delay_ms(value: Option<u64>) -> u64 {
    normalize_u64(
        value,
        STREAM_IDLE_RETRY_DELAY_MS_DEFAULT,
        STREAM_IDLE_RETRY_DELAY_MS_MAX,
    )
}

fn normalize_turn_recovery_messages_limit(value: Option<u32>) -> u32 {
    normalize_u32(
        value,
        TURN_RECOVERY_MESSAGES_LIMIT_DEFAULT,
        TURN_RECOVERY_MESSAGES_LIMIT_MAX,
    )
}

fn normalize_turn_recovery_not_found_retry_max_attempts(value: Option<u32>) -> u32 {
    normalize_u32(
        value,
        TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS_DEFAULT,
        TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS_MAX,
    )
}

fn normalize_turn_recovery_poll_in_progress_max_attempts(value: Option<u32>) -> u32 {
    normalize_u32(
        value,
        TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS_DEFAULT,
        TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS_MAX,
    )
}

fn normalize_turn_recovery_poll_in_progress_delay_ms(value: Option<u64>) -> u64 {
    normalize_u64(
        value,
        TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS_DEFAULT,
        TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS_MAX,
    )
}

fn normalize_turn_in_progress_retry_max_attempts(value: Option<u32>) -> u32 {
    normalize_u32(
        value,
        TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS_DEFAULT,
        TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS_MAX,
    )
}

fn normalize_turn_in_progress_retry_delay_ms(value: Option<u64>) -> u64 {
    normalize_u64(
        value,
        TURN_IN_PROGRESS_RETRY_DELAY_MS_DEFAULT,
        TURN_IN_PROGRESS_RETRY_DELAY_MS_MAX,
    )
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
    let stream_idle_timeout_ms =
        normalize_stream_idle_timeout_ms(parsed.recovery.stream_idle_timeout_ms);
    let stream_idle_retry_max_attempts =
        normalize_stream_idle_retry_max_attempts(parsed.recovery.stream_idle_retry_max_attempts);
    let stream_idle_retry_delay_ms =
        normalize_stream_idle_retry_delay_ms(parsed.recovery.stream_idle_retry_delay_ms);
    let turn_recovery_messages_limit =
        normalize_turn_recovery_messages_limit(parsed.recovery.turn_recovery_messages_limit);
    let turn_recovery_not_found_retry_max_attempts =
        normalize_turn_recovery_not_found_retry_max_attempts(
            parsed.recovery.turn_recovery_not_found_retry_max_attempts,
        );
    let turn_recovery_poll_in_progress_max_attempts =
        normalize_turn_recovery_poll_in_progress_max_attempts(
            parsed.recovery.turn_recovery_poll_in_progress_max_attempts,
        );
    let turn_recovery_poll_in_progress_delay_ms = normalize_turn_recovery_poll_in_progress_delay_ms(
        parsed.recovery.turn_recovery_poll_in_progress_delay_ms,
    );
    let turn_in_progress_retry_max_attempts = normalize_turn_in_progress_retry_max_attempts(
        parsed.recovery.turn_in_progress_retry_max_attempts,
    );
    let turn_in_progress_retry_delay_ms =
        normalize_turn_in_progress_retry_delay_ms(parsed.recovery.turn_in_progress_retry_delay_ms);
    Ok(GatewayConfigPayload {
        api_base_url: parsed.gateway.api_base_url.trim().to_string(),
        api_key: parsed.gateway.api_key.trim().to_string(),
        llm_api_base_url: normalize_llm_api_base_url(parsed.llm.api_base_url.as_str()),
        llm_api_key: parsed.llm.api_key.trim().to_string(),
        llm_translation_model: normalize_llm_translation_model(parsed.llm.translation_model.as_str()),
        theme: normalize_theme_mode(parsed.appearance.theme.as_str()),
        font_size: normalize_font_size_mode(parsed.appearance.font_size.as_str()),
        timezone: normalize_timezone(parsed.personalization.timezone.as_str()),
        polymarket_enabled: parsed.subscriptions.polymarket_enabled,
        stream_idle_timeout_ms,
        stream_idle_retry_max_attempts,
        stream_idle_retry_delay_ms,
        turn_recovery_messages_limit,
        turn_recovery_not_found_retry_max_attempts,
        turn_recovery_poll_in_progress_max_attempts,
        turn_recovery_poll_in_progress_delay_ms,
        turn_in_progress_retry_max_attempts,
        turn_in_progress_retry_delay_ms,
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

    let stream_idle_timeout_ms =
        normalize_stream_idle_timeout_ms(parsed.recovery.stream_idle_timeout_ms);
    let stream_idle_retry_max_attempts =
        normalize_stream_idle_retry_max_attempts(parsed.recovery.stream_idle_retry_max_attempts);
    let stream_idle_retry_delay_ms =
        normalize_stream_idle_retry_delay_ms(parsed.recovery.stream_idle_retry_delay_ms);
    let turn_recovery_messages_limit =
        normalize_turn_recovery_messages_limit(parsed.recovery.turn_recovery_messages_limit);
    let turn_recovery_not_found_retry_max_attempts =
        normalize_turn_recovery_not_found_retry_max_attempts(
            parsed.recovery.turn_recovery_not_found_retry_max_attempts,
        );
    let turn_recovery_poll_in_progress_max_attempts =
        normalize_turn_recovery_poll_in_progress_max_attempts(
            parsed.recovery.turn_recovery_poll_in_progress_max_attempts,
        );
    let turn_recovery_poll_in_progress_delay_ms = normalize_turn_recovery_poll_in_progress_delay_ms(
        parsed.recovery.turn_recovery_poll_in_progress_delay_ms,
    );
    let turn_in_progress_retry_max_attempts = normalize_turn_in_progress_retry_max_attempts(
        parsed.recovery.turn_in_progress_retry_max_attempts,
    );
    let turn_in_progress_retry_delay_ms =
        normalize_turn_in_progress_retry_delay_ms(parsed.recovery.turn_in_progress_retry_delay_ms);
    parsed.recovery.stream_idle_timeout_ms = Some(stream_idle_timeout_ms);
    parsed.recovery.stream_idle_retry_max_attempts = Some(stream_idle_retry_max_attempts);
    parsed.recovery.stream_idle_retry_delay_ms = Some(stream_idle_retry_delay_ms);
    parsed.recovery.turn_recovery_messages_limit = Some(turn_recovery_messages_limit);
    parsed.recovery.turn_recovery_not_found_retry_max_attempts =
        Some(turn_recovery_not_found_retry_max_attempts);
    parsed.recovery.turn_recovery_poll_in_progress_max_attempts =
        Some(turn_recovery_poll_in_progress_max_attempts);
    parsed.recovery.turn_recovery_poll_in_progress_delay_ms =
        Some(turn_recovery_poll_in_progress_delay_ms);
    parsed.recovery.turn_in_progress_retry_max_attempts = Some(turn_in_progress_retry_max_attempts);
    parsed.recovery.turn_in_progress_retry_delay_ms = Some(turn_in_progress_retry_delay_ms);
    write_gateway_config_toml(&config_path, &parsed)?;

    Ok(GatewayConfigPayload {
        api_base_url: parsed.gateway.api_base_url,
        api_key: parsed.gateway.api_key,
        llm_api_base_url: normalize_llm_api_base_url(parsed.llm.api_base_url.as_str()),
        llm_api_key: parsed.llm.api_key.trim().to_string(),
        llm_translation_model: normalize_llm_translation_model(parsed.llm.translation_model.as_str()),
        theme: normalize_theme_mode(parsed.appearance.theme.as_str()),
        font_size: normalize_font_size_mode(parsed.appearance.font_size.as_str()),
        timezone: normalize_timezone(parsed.personalization.timezone.as_str()),
        polymarket_enabled: parsed.subscriptions.polymarket_enabled,
        stream_idle_timeout_ms,
        stream_idle_retry_max_attempts,
        stream_idle_retry_delay_ms,
        turn_recovery_messages_limit,
        turn_recovery_not_found_retry_max_attempts,
        turn_recovery_poll_in_progress_max_attempts,
        turn_recovery_poll_in_progress_delay_ms,
        turn_in_progress_retry_max_attempts,
        turn_in_progress_retry_delay_ms,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "camelCase")]
fn save_llm_config(
    app: tauri::AppHandle,
    llm_api_base_url: String,
    llm_api_key: String,
    llm_translation_model: String,
) -> Result<LlmConfigPayload, String> {
    let config_path = resolve_app_config_toml_path(&app)?;
    let mut parsed = read_gateway_config_toml(&config_path).unwrap_or_default();
    parsed.llm.api_base_url = normalize_llm_api_base_url(llm_api_base_url.as_str());
    parsed.llm.api_key = llm_api_key.trim().to_string();
    parsed.llm.translation_model = normalize_llm_translation_model(llm_translation_model.as_str());
    write_gateway_config_toml(&config_path, &parsed)?;

    Ok(LlmConfigPayload {
        llm_api_base_url: parsed.llm.api_base_url,
        llm_api_key: parsed.llm.api_key,
        llm_translation_model: parsed.llm.translation_model,
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
fn save_personalization_config(
    app: tauri::AppHandle,
    timezone: String,
) -> Result<PersonalizationConfigPayload, String> {
    let config_path = resolve_app_config_toml_path(&app)?;
    let mut parsed = read_gateway_config_toml(&config_path).unwrap_or_default();
    parsed.personalization.timezone = normalize_timezone(timezone.as_str());
    write_gateway_config_toml(&config_path, &parsed)?;

    Ok(PersonalizationConfigPayload {
        timezone: parsed.personalization.timezone,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "camelCase")]
fn save_subscriptions_config(
    app: tauri::AppHandle,
    polymarket_enabled: bool,
) -> Result<SubscriptionsConfigPayload, String> {
    let config_path = resolve_app_config_toml_path(&app)?;
    let mut parsed = read_gateway_config_toml(&config_path).unwrap_or_default();
    parsed.subscriptions.polymarket_enabled = polymarket_enabled;
    write_gateway_config_toml(&config_path, &parsed)?;

    Ok(SubscriptionsConfigPayload {
        polymarket_enabled: parsed.subscriptions.polymarket_enabled,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn check_app_update(app: tauri::AppHandle) -> AppUpdateCheckResponse {
    let current_version = app.package_info().version.to_string();
    let updater = match build_runtime_updater(&app) {
        Ok(Some(updater)) => updater,
        Ok(None) => {
            return AppUpdateCheckResponse {
                enabled: false,
                available: false,
                current_version,
                version: None,
                notes: None,
                pub_date: None,
                error: None,
            };
        }
        Err(error) => {
            return AppUpdateCheckResponse {
                enabled: false,
                available: false,
                current_version,
                version: None,
                notes: None,
                pub_date: None,
                error: Some(error),
            };
        }
    };

    match updater.check().await {
        Ok(Some(update)) => AppUpdateCheckResponse {
            enabled: true,
            available: true,
            current_version: update.current_version.clone(),
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            pub_date: update.date.map(|value| value.to_string()),
            error: None,
        },
        Ok(None) => AppUpdateCheckResponse {
            enabled: true,
            available: false,
            current_version,
            version: None,
            notes: None,
            pub_date: None,
            error: None,
        },
        Err(error) => AppUpdateCheckResponse {
            enabled: true,
            available: false,
            current_version,
            version: None,
            notes: None,
            pub_date: None,
            error: Some(error.to_string()),
        },
    }
}

#[tauri::command]
async fn prepare_app_update(app: tauri::AppHandle) -> AppUpdatePrepareResponse {
    let prepared_state = app.state::<PreparedAppUpdateState>();
    let current_version = app.package_info().version.to_string();
    let updater = match build_runtime_updater(&app) {
        Ok(Some(updater)) => updater,
        Ok(None) => {
            if let Ok(mut guard) = prepared_state.update.lock() {
                *guard = None;
            }
            return AppUpdatePrepareResponse {
                enabled: false,
                available: false,
                downloaded: false,
                current_version,
                version: None,
                notes: None,
                pub_date: None,
                error: None,
            };
        }
        Err(error) => {
            return AppUpdatePrepareResponse {
                enabled: false,
                available: false,
                downloaded: false,
                current_version,
                version: None,
                notes: None,
                pub_date: None,
                error: Some(error),
            };
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            if let Ok(mut guard) = prepared_state.update.lock() {
                *guard = None;
            }
            return AppUpdatePrepareResponse {
                enabled: true,
                available: false,
                downloaded: false,
                current_version,
                version: None,
                notes: None,
                pub_date: None,
                error: None,
            };
        }
        Err(error) => {
            return AppUpdatePrepareResponse {
                enabled: true,
                available: false,
                downloaded: false,
                current_version,
                version: None,
                notes: None,
                pub_date: None,
                error: Some(error.to_string()),
            };
        }
    };

    let next_version = update.version.clone();
    let next_current_version = update.current_version.clone();
    let next_notes = update.body.clone();
    let next_pub_date = update.date.map(|value| value.to_string());

    if let Ok(guard) = prepared_state.update.lock() {
        if let Some(prepared) = guard.as_ref() {
            if prepared.version == next_version && prepared.current_version == next_current_version
            {
                return AppUpdatePrepareResponse {
                    enabled: true,
                    available: true,
                    downloaded: true,
                    current_version: next_current_version,
                    version: Some(next_version),
                    notes: next_notes,
                    pub_date: next_pub_date,
                    error: None,
                };
            }
        }
    }

    if let Ok(mut guard) = prepared_state.update.lock() {
        *guard = None;
    }

    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            if let Ok(mut guard) = prepared_state.update.lock() {
                *guard = Some(PreparedAppUpdate {
                    current_version: next_current_version.clone(),
                    version: next_version.clone(),
                    bytes,
                });
            }
            AppUpdatePrepareResponse {
                enabled: true,
                available: true,
                downloaded: true,
                current_version: next_current_version,
                version: Some(next_version),
                notes: next_notes,
                pub_date: next_pub_date,
                error: None,
            }
        }
        Err(error) => AppUpdatePrepareResponse {
            enabled: true,
            available: true,
            downloaded: false,
            current_version: next_current_version,
            version: Some(next_version),
            notes: next_notes,
            pub_date: next_pub_date,
            error: Some(error.to_string()),
        },
    }
}

#[tauri::command]
async fn install_prepared_app_update(app: tauri::AppHandle) -> AppUpdateInstallResponse {
    let prepared_state = app.state::<PreparedAppUpdateState>();
    let current_version = app.package_info().version.to_string();
    let updater = match build_runtime_updater(&app) {
        Ok(Some(updater)) => updater,
        Ok(None) => {
            return AppUpdateInstallResponse {
                enabled: false,
                installed: false,
                current_version,
                version: None,
                error: None,
            };
        }
        Err(error) => {
            return AppUpdateInstallResponse {
                enabled: false,
                installed: false,
                current_version,
                version: None,
                error: Some(error),
            };
        }
    };

    let prepared = match prepared_state.update.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };

    let Some(prepared) = prepared else {
        return AppUpdateInstallResponse {
            enabled: true,
            installed: false,
            current_version,
            version: None,
            error: Some("no_prepared_update".to_string()),
        };
    };

    let PreparedAppUpdate {
        current_version: prepared_current_version,
        version: prepared_version,
        bytes,
    } = prepared;

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return AppUpdateInstallResponse {
                enabled: true,
                installed: false,
                current_version,
                version: Some(prepared_version),
                error: Some("no_update_available".to_string()),
            };
        }
        Err(error) => {
            if let Ok(mut guard) = prepared_state.update.lock() {
                *guard = Some(PreparedAppUpdate {
                    current_version: prepared_current_version,
                    version: prepared_version,
                    bytes,
                });
            }
            return AppUpdateInstallResponse {
                enabled: true,
                installed: false,
                current_version,
                version: None,
                error: Some(error.to_string()),
            };
        }
    };

    if update.version != prepared_version || update.current_version != prepared_current_version {
        return AppUpdateInstallResponse {
            enabled: true,
            installed: false,
            current_version: update.current_version.clone(),
            version: Some(update.version.clone()),
            error: Some("prepared_update_stale".to_string()),
        };
    }

    let next_version = update.version.clone();
    let current_version = update.current_version.clone();

    match update.install(bytes.as_slice()) {
        Ok(()) => {
            app.request_restart();
            AppUpdateInstallResponse {
                enabled: true,
                installed: true,
                current_version,
                version: Some(next_version),
                error: None,
            }
        }
        Err(error) => {
            if let Ok(mut guard) = prepared_state.update.lock() {
                *guard = Some(PreparedAppUpdate {
                    current_version: prepared_current_version,
                    version: prepared_version,
                    bytes,
                });
            }
            AppUpdateInstallResponse {
                enabled: true,
                installed: false,
                current_version,
                version: Some(next_version),
                error: Some(error.to_string()),
            }
        }
    }
}

#[tauri::command]
async fn install_app_update(app: tauri::AppHandle) -> AppUpdateInstallResponse {
    let current_version = app.package_info().version.to_string();
    let updater = match build_runtime_updater(&app) {
        Ok(Some(updater)) => updater,
        Ok(None) => {
            return AppUpdateInstallResponse {
                enabled: false,
                installed: false,
                current_version,
                version: None,
                error: None,
            };
        }
        Err(error) => {
            return AppUpdateInstallResponse {
                enabled: false,
                installed: false,
                current_version,
                version: None,
                error: Some(error),
            };
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return AppUpdateInstallResponse {
                enabled: true,
                installed: false,
                current_version,
                version: None,
                error: Some("no_update_available".to_string()),
            };
        }
        Err(error) => {
            return AppUpdateInstallResponse {
                enabled: true,
                installed: false,
                current_version,
                version: None,
                error: Some(error.to_string()),
            };
        }
    };

    let next_version = update.version.clone();
    let current_version = update.current_version.clone();

    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            app.request_restart();
            AppUpdateInstallResponse {
                enabled: true,
                installed: true,
                current_version,
                version: Some(next_version),
                error: None,
            }
        }
        Err(error) => AppUpdateInstallResponse {
            enabled: true,
            installed: false,
            current_version,
            version: Some(next_version),
            error: Some(error.to_string()),
        },
    }
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

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ICON_ID: &str = "main-tray";
const TRAY_SHOW_WINDOW_MENU_ID: &str = "tray-show-window";
const TRAY_QUIT_MENU_ID: &str = "tray-quit";

struct CloseToTrayState {
    quitting: AtomicBool,
}

impl Default for CloseToTrayState {
    fn default() -> Self {
        Self {
            quitting: AtomicBool::new(false),
        }
    }
}

impl CloseToTrayState {
    fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::Relaxed);
    }

    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Relaxed)
    }
}

fn restore_main_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    if let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let tray_menu = MenuBuilder::new(app)
        .text(TRAY_SHOW_WINDOW_MENU_ID, "显示窗口")
        .separator()
        .text(TRAY_QUIT_MENU_ID, "退出")
        .build()?;

    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .menu(&tray_menu)
        .tooltip("NBSearch")
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &tauri::AppHandle<R>, event: tauri::menu::MenuEvent| {
            match event.id().as_ref() {
                TRAY_SHOW_WINDOW_MENU_ID => restore_main_window(app),
                TRAY_QUIT_MENU_ID => {
                    app.state::<CloseToTrayState>().mark_quitting();
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray: &tauri::tray::TrayIcon<R>, event: TrayIconEvent| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        });

    let tray_icon = tauri::image::Image::new(
        &tray_icon_rgba::TRAY_TEMPLATE_ICON_RGBA,
        tray_icon_rgba::TRAY_TEMPLATE_ICON_WIDTH,
        tray_icon_rgba::TRAY_TEMPLATE_ICON_HEIGHT,
    );
    tray_builder = tray_builder.icon(tray_icon);

    #[cfg(target_os = "macos")]
    {
        tray_builder = tray_builder.icon_as_template(true);
    }

    let _tray = tray_builder.build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(PreparedAppUpdateState::default())
        .manage(CloseToTrayState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            setup_tray(&app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW_LABEL => {
                if !window.state::<CloseToTrayState>().is_quitting() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            append_client_log,
            resolve_storage_paths,
            read_gateway_config,
            save_gateway_config,
            save_llm_config,
            save_appearance_config,
            save_personalization_config,
            save_subscriptions_config,
            check_app_update,
            prepare_app_update,
            install_prepared_app_update,
            install_app_update,
            fetch_image_with_tls_profile,
            fetch_image_with_cache,
            get_image_cache_stats,
            clear_image_cache,
            download_image_to_downloads,
            save_pdf_document
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            restore_main_window(app_handle);
        }
    });
}
