# Tabula cloud sharing service

This standalone Cloudflare Worker provides Tabula's encrypted persistent collaboration rooms. A SQLite-backed Durable Object handles authenticated WebSockets, encrypted storage, ordering, revocation, and the 30-day deletion alarm.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Edwa0506/tabula-cloud-sharing)

Cloudflare automatically provisions the free-plan-compatible Durable Object in `wrangler.jsonc` during button deployment. No R2 subscription or payment method is required. Each shared project is capped at 256 MiB and 10,000 stored records; Cloudflare's Workers Free limits fail closed instead of creating usage charges. After deployment, copy the Worker's `https://…workers.dev` address into Tabula's **Shared Projects** screen.

For local development:

```sh
npm install
npm run check
npm run dev
```

## License

AGPL-3.0-only. See `LICENSE`.
