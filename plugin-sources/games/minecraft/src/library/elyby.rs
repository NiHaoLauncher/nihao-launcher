//! Ely.by accounts: signing in against its Yggdrasil-compatible `authserver` to prove the
//! nickname is the player's own. Passwords are never kept, only the token Ely.by hands back.
use serde::{Deserialize, Serialize};

use crate::library::install::HTTP;

const AUTH_URL: &str = "https://authserver.ely.by/auth";

/// What Ely.by returned for a successful sign-in or refresh.
#[derive(Serialize, Deserialize, Clone)]
pub struct ElybyAccount {
    pub name: String,
    /// Undashed, as Ely.by gives it.
    pub uuid: String,
    pub access_token: String,
    pub client_token: String,
}

async fn post(endpoint: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let response = HTTP.post(format!("{AUTH_URL}/{endpoint}")).json(&body).send().await
        .map_err(|e| format!("Cannot reach Ely.by: {e}"))?;
    let status = response.status();
    let json: serde_json::Value = response.json().await.unwrap_or_default();
    if status.is_success() {
        return Ok(json);
    }
    Err(json["errorMessage"].as_str().map(str::to_string).unwrap_or_else(|| format!("Ely.by refused the sign-in ({status})")))
}

fn parse_account(json: &serde_json::Value, client_token: Option<&str>) -> Result<ElybyAccount, String> {
    let profile = &json["selectedProfile"];
    Ok(ElybyAccount {
        name: profile["name"].as_str().ok_or("This Ely.by account has no Minecraft profile")?.to_string(),
        uuid: profile["id"].as_str().unwrap_or_default().to_string(),
        access_token: json["accessToken"].as_str().ok_or("Ely.by sent no token")?.to_string(),
        client_token: json["clientToken"].as_str().or(client_token).unwrap_or_default().to_string(),
    })
}

/// shortcut: an account with two-factor auth must put the code after the password (`password:123456`,
/// Ely.by's own convention); give the form a separate code field if people trip on it.
pub async fn authenticate(login: &str, password: &str) -> Result<ElybyAccount, String> {
    let json = post("authenticate", serde_json::json!({ "username": login, "password": password, "requestUser": true })).await?;
    parse_account(&json, None)
}

/// Swaps the saved token for a fresh one (the old one stays valid on Ely.by's side until then).
/// An error means the player has to sign in again.
pub async fn refresh(access_token: &str, client_token: &str) -> Result<ElybyAccount, String> {
    let json = post("refresh", serde_json::json!({ "accessToken": access_token, "clientToken": client_token })).await?;
    parse_account(&json, Some(client_token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_comes_from_the_selected_profile() {
        let json = serde_json::json!({ "accessToken": "a", "clientToken": "c", "selectedProfile": { "id": "u", "name": "Alex" } });
        let account = parse_account(&json, None).unwrap();
        assert_eq!((account.name.as_str(), account.uuid.as_str(), account.client_token.as_str()), ("Alex", "u", "c"));
        assert!(parse_account(&serde_json::json!({ "accessToken": "a" }), None).is_err(), "no profile, no account");
    }
}
