use std::ffi::OsStr;

use serde_json::Value;

use crate::get_program_path;

#[tauri::command]
pub async fn get_lang_list() -> Result<Vec<(String, String)>, String> {
    let path = get_program_path().map_err(|e|e.to_string())?.join("lang");
    let mut result: Vec<(String, String)> = vec![];
    
    if !path.exists() { return Err("Not language folder".to_string()); }
    for entry in path.read_dir().map_err(|e|e.to_string())? {
        let file = entry.map_err(|e|e.to_string())?;
        if file.path().is_file() && file.path().exists() &&
            file.path().extension().and_then(OsStr::to_str)==Some("json") 
        {
            let content = tokio::fs::read_to_string(file.path()).await
                .map_err(|e|e.to_string())?;
            let json:Value = serde_json::from_str(&content)
                .map_err(|e|e.to_string())?;
            let language = json["language"].as_str().unwrap();

            result.push( (file.path().file_stem().unwrap().to_str().unwrap().to_string(),  language.to_string()) );
        }
    }
    
    Ok(result)
}
#[tauri::command]
pub async fn get_lang(id:String) -> Result<Value, String> {
    let path = get_program_path().map_err(|e|e.to_string())?.join("lang").join(format!("{}.json",id));
    let content = tokio::fs::read_to_string(path).await
        .map_err(|e|e.to_string())?;
    let data: Value = serde_json::from_str(&content).map_err(|e|e.to_string())?;
    Ok(data)
}