# Tabula cloud sharing service

This standalone Cloudflare Worker provides Tabula's encrypted persistent collaboration rooms. A Durable Object handles authenticated WebSockets, ordering, revocation, and the 30-day deletion alarm. R2 stores only encrypted snapshots and updates.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Edwa0506/tabula-cloud-sharing)

Cloudflare automatically provisions the resources in `wrangler.jsonc` during button deployment. After deployment, copy the Worker's `https://…workers.dev` address into Tabula's **Shared Projects** screen.

For local development:

```sh
pnpm install
pnpm check
pnpm dev
```

## License

AGPL-3.0-only. See `LICENSE`.
