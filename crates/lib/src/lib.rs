pub use {axum, clap, regex, reqwest, serde_json, tokio, tracing, tracing_subscriber};

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct Item {
    pub name: String,
    pub n: u64,
}

pub fn parse(s: &str) -> Item {
    serde_json::from_str(s).unwrap()
}

pub fn router() -> axum::Router {
    axum::Router::new().route("/", axum::routing::get(|| async { "ok" }))
}

pub fn revision() -> u64 {
    1
}
