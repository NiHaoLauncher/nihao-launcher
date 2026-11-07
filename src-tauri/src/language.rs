use std::ffi::OsStr;
use std::path::Path;

use serde_json::Value;

use crate::get_program_path;

/// A language id is a plain file name (`en_us`): the page sends it, and it becomes part of a path.
fn is_language_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `(id, display name)` of a `lang/<id>.json` file, or `None` for anything that is not a usable
/// language file (not json, damaged, no `"language"` key): one bad file must not empty the list.
async fn language_of(file: &Path) -> Option<(String, String)> {
    if file.extension().and_then(OsStr::to_str) != Some("json") {
        return None;
    }
    let id = file.file_stem()?.to_str()?.to_string();
    let json: Value = serde_json::from_str(&tokio::fs::read_to_string(file).await.ok()?).ok()?;
    let name = json["language"].as_str()?.to_string();
    Some((id, name))
}

#[tauri::command]
pub async fn get_lang_list() -> Result<Vec<(String, String)>, String> {
    let path = get_program_path().map_err(|e| e.to_string())?.join("lang");
    if !path.exists() {
        return Err("Not language folder".to_string());
    }
    let mut result = Vec::new();
    for entry in path.read_dir().map_err(|e| e.to_string())?.flatten() {
        let file = entry.path();
        if !file.is_file() {
            continue;
        }
        match language_of(&file).await {
            Some(language) => result.push(language),
            None if file.extension().and_then(OsStr::to_str) == Some("json") => {
                eprintln!("[lang] skipped '{}': no \"language\" key or not valid json", file.display());
            }
            None => {}
        }
    }
    result.sort();
    Ok(result)
}

#[tauri::command]
pub async fn get_lang(id: String) -> Result<Value, String> {
    if !is_language_id(&id) {
        return Err(format!("'{id}' is not a language id"));
    }
    let mut data = read_core_lang(&id).await?;

    // Layer every loaded module's own dictionary (`minecraft.*` keys, from its `get_lang`) over
    // the launcher's, so the frontend gets one complete dictionary. A module without a file for
    // this language, or without `get_lang`, contributes nothing.
    if let Value::Object(map) = &mut data {
        for extra in crate::collect_from_plugins("get_lang", serde_json::json!({ "id": id })) {
            if let Value::Object(extra) = extra {
                map.extend(extra);
            }
        }
    }
    Ok(data)
}

async fn read_core_lang(id: &str) -> Result<Value, String> {
    let path = get_program_path().map_err(|e| e.to_string())?.join("lang").join(format!("{}.json", id));
    let content = tokio::fs::read_to_string(path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_names_are_language_ids() {
        for good in ["en_us", "uk_ua", "pt-br", "cs_cz"] {
            assert!(is_language_id(good), "{good}");
        }
        for bad in ["", "../local", "a/b", "a\\b", "C:x", "en_us.json", &"x".repeat(65)] {
            assert!(!is_language_id(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn a_damaged_language_file_is_skipped_not_fatal() {
        let dir = std::env::temp_dir().join(format!("nihao-lang-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("en_us.json"), r#"{"language":"English"}"#).unwrap();
        std::fs::write(dir.join("nokey.json"), r#"{"other":1}"#).unwrap();
        std::fs::write(dir.join("broken.json"), "{ not json").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();

        assert_eq!(language_of(&dir.join("en_us.json")).await, Some(("en_us".into(), "English".into())));
        for skipped in ["nokey.json", "broken.json", "notes.txt", "missing.json"] {
            assert_eq!(language_of(&dir.join(skipped)).await, None, "{skipped}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
