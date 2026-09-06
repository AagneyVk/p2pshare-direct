#[tokio::main]
async fn main() -> anyhow::Result<()> {
    p2pshare_transport::engine::run(tokio::io::stdin(), tokio::io::stdout()).await
}
