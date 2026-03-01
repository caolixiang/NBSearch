#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, time::Duration};

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
        let name = HeaderName::from_bytes(name_raw.trim().as_bytes())
            .map_err(|e| format!("invalid header name {name_raw}: {e}"))?;
        let value = HeaderValue::from_str(value_raw.trim())
            .map_err(|e| format!("invalid header value for {name}: {e}"))?;
        headers.insert(name, value);
    }

    Ok(headers)
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![runtime_info, fetch_image_with_tls_profile])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
