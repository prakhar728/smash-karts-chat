use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Context;
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use tokio::io::AsyncWriteExt;
use chrono::{DateTime, Utc};
use futures::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, mpsc};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    rooms: Arc<RwLock<HashMap<String, Room>>>,
    auth: AuthService,
}

#[derive(Clone, Default)]
struct Room {
    users: HashMap<Uuid, UserSession>,
    next_player_num: u32,
}

#[derive(Clone)]
struct UserSession {
    profile: UserProfile,
    tx: mpsc::UnboundedSender<ServerWsMessage>,
}

#[derive(Clone)]
struct AuthService {
    google_client_id: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    mode: String,
    provider: Option<String>,
    token: Option<String>,
    play_name: Option<String>,
    play_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserProfile {
    id: String,
    display_name: String,
    picture: Option<String>,
    provider: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientWsMessage {
    Chat { text: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerWsMessage {
    System {
        text: String,
        room: String,
        at: DateTime<Utc>,
    },
    Chat {
        room: String,
        text: String,
        from: UserProfile,
        at: DateTime<Utc>,
    },
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Deserialize)]
struct GoogleTokenInfo {
    aud: String,
    sub: String,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Deserialize)]
struct GoogleUserInfo {
    sub: String,
    name: Option<String>,
    picture: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let google_client_id = std::env::var("GOOGLE_CLIENT_ID")
        .context("GOOGLE_CLIENT_ID must be set (Chrome extension OAuth client id)")?;
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());

    let state = AppState {
        rooms: Arc::new(RwLock::new(HashMap::new())),
        auth: AuthService {
            google_client_id,
            http: reqwest::Client::new(),
        },
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler))
        .route("/log", post(log_entry))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    info!("chat server listening on {}", bind_addr);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(HealthResponse { ok: true })
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<WsQuery>,
) -> Response {
    let room = normalize_room(&query.mode);
    if room.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing game mode").into_response();
    }

    let profile = match authenticate(&state.auth, &query).await {
        Ok(profile) => profile,
        Err(e) => {
            warn!("authentication failed: {e}");
            return (StatusCode::UNAUTHORIZED, "Auth failed").into_response();
        }
    };

    ws.on_upgrade(move |socket| handle_socket(state, socket, room, profile))
}

const RATE_LIMIT: Duration = Duration::from_millis(500); // max 2 messages/sec per user

fn normalize_room(mode: &str) -> String {
    mode.trim().to_lowercase().replace(' ', "-")
}

async fn authenticate(auth: &AuthService, query: &WsQuery) -> anyhow::Result<UserProfile> {
    match query.provider.as_deref().unwrap_or("google") {
        "google" => {
            let token = query.token.as_deref().context("Missing token for google auth")?;
            auth.verify_google_id_token(token).await
        }
        "google_access_token" => {
            let token = query
                .token
                .as_deref()
                .context("Missing token for google access token auth")?;
            auth.verify_google_access_token(token).await
        }
        "play" => {
            let name = query
                .play_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .unwrap_or("Player");
            let id = query
                .play_id
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("play-{}", Uuid::new_v4()));
            Ok(UserProfile {
                id,
                display_name: name.to_string(),
                picture: None,
                provider: "play".to_string(),
            })
        }
        _ => anyhow::bail!("Unsupported provider"),
    }
}

impl AuthService {
    async fn verify_google_id_token(&self, id_token: &str) -> anyhow::Result<UserProfile> {
        let info = self
            .http
            .get("https://oauth2.googleapis.com/tokeninfo")
            .query(&[("id_token", id_token)])
            .send()
            .await?
            .error_for_status()?
            .json::<GoogleTokenInfo>()
            .await?;

        if info.aud != self.google_client_id {
            anyhow::bail!("Token audience mismatch")
        }

        Ok(UserProfile {
            id: info.sub,
            display_name: info.name.unwrap_or_else(|| "Google User".to_string()),
            picture: info.picture,
            provider: "google".to_string(),
        })
    }

    async fn verify_google_access_token(&self, access_token: &str) -> anyhow::Result<UserProfile> {
        let info = self
            .http
            .get("https://www.googleapis.com/oauth2/v3/userinfo")
            .bearer_auth(access_token)
            .send()
            .await?
            .error_for_status()?
            .json::<GoogleUserInfo>()
            .await?;

        Ok(UserProfile {
            id: info.sub,
            display_name: info.name.unwrap_or_else(|| "Google User".to_string()),
            picture: info.picture,
            provider: "google".to_string(),
        })
    }
}

async fn handle_socket(state: AppState, socket: WebSocket, room: String, mut profile: UserProfile) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerWsMessage>();
    let user_id = Uuid::new_v4();

    {
        let mut rooms = state.rooms.write().await;
        let room_entry = rooms.entry(room.clone()).or_default();
        // Assign sequential number only when no real name was provided
        if profile.provider == "play" && profile.display_name == "Player" {
            room_entry.next_player_num += 1;
            profile.display_name = format!("Player {}", room_entry.next_player_num);
        }
        room_entry.users.insert(
            user_id,
            UserSession {
                profile: profile.clone(),
                tx: tx.clone(),
            },
        );
    }

    let join_msg = ServerWsMessage::System {
        text: format!("{} joined", profile.display_name),
        room: room.clone(),
        at: Utc::now(),
    };
    broadcast_room(&state, &room, join_msg).await;

    let state_for_reader = state.clone();
    let room_for_reader = room.clone();
    let profile_for_reader = profile.clone();

    let reader = tokio::spawn(async move {
        let mut last_msg = Instant::now() - RATE_LIMIT;
        while let Some(Ok(message)) = receiver.next().await {
            match message {
                Message::Text(raw) => {
                    if let Ok(client_msg) = serde_json::from_str::<ClientWsMessage>(&raw) {
                        match client_msg {
                            ClientWsMessage::Chat { text } => {
                                let text = text.trim();
                                if text.is_empty() || text.len() > 500 {
                                    continue;
                                }
                                let now = Instant::now();
                                if now.duration_since(last_msg) < RATE_LIMIT {
                                    continue;
                                }
                                last_msg = now;
                                broadcast_room(
                                    &state_for_reader,
                                    &room_for_reader,
                                    ServerWsMessage::Chat {
                                        room: room_for_reader.clone(),
                                        text: text.to_string(),
                                        from: profile_for_reader.clone(),
                                        at: Utc::now(),
                                    },
                                )
                                .await;
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(payload) => {
                    if sender.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    error!("failed to serialize ws message: {e}");
                    break;
                }
            }
        }
    });

    tokio::select! {
        _ = reader => {},
        _ = writer => {},
    }

    {
        let mut rooms = state.rooms.write().await;
        if let Some(room_state) = rooms.get_mut(&room) {
            room_state.users.remove(&user_id);
            if room_state.users.is_empty() {
                rooms.remove(&room);
            }
        }
    }

    broadcast_room(
        &state,
        &room,
        ServerWsMessage::System {
            text: format!("{} left", profile.display_name),
            room: room.clone(),
            at: Utc::now(),
        },
    )
    .await;
}

async fn broadcast_room(state: &AppState, room: &str, msg: ServerWsMessage) {
    let subscribers: Vec<mpsc::UnboundedSender<ServerWsMessage>> = {
        let rooms = state.rooms.read().await;
        rooms
            .get(room)
            .map(|room_state| room_state.users.values().map(|u| u.tx.clone()).collect())
            .unwrap_or_default()
    };

    for tx in subscribers {
        let _ = tx.send(msg.clone());
    }
}

async fn log_entry(Json(payload): Json<serde_json::Value>) -> impl IntoResponse {
    let line = match serde_json::to_string(&payload) {
        Ok(s) => format!("{s}\n"),
        Err(e) => {
            error!("log: failed to serialize: {e}");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("game-traffic.log")
        .await
    {
        Ok(mut file) => {
            if let Err(e) = file.write_all(line.as_bytes()).await {
                error!("log: write failed: {e}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
        Err(e) => {
            error!("log: open failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    StatusCode::NO_CONTENT.into_response()
}
