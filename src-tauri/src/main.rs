#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, path::PathBuf, time::Duration};

use serde::Serialize;
use tauri::Manager;
use wreq::Client;
use wreq::header::{HeaderMap, HeaderName, HeaderValue};
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

fn host_emulation_os() -> EmulationOS {
    match std::env::consts::OS {
        "windows" => EmulationOS::Windows,
        "linux" => EmulationOS::Linux,
        "android" => EmulationOS::Android,
        "ios" => EmulationOS::IOS,
        _ => EmulationOS::MacOS,
    }
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
        std::fs::create_dir_all(parent).map_err(|e| format!("prepare destination dir failed: {e}"))?;
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
            fetch_image_with_tls_profile,
            download_image_to_downloads
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
