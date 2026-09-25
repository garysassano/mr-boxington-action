fn main() {
    let item = bench_lib::parse(r#"{"name":"x","n":0}"#);
    let _ = bench_lib::router();
    let _ = bench_lib::reqwest::Client::new();
    println!("{item:?} {}", bench_lib::regex::Regex::new("a+").unwrap().is_match("aa"));
}
