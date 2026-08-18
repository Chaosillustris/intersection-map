# Cloudflare Pages Deployment

This project can be published to Cloudflare Pages without OpenAI hosting.

## 1. Authenticate Wrangler

```bash
npx wrangler login
```

## 2. Build the static bundle

```bash
npm run build:cloudflare
```

This creates `dist-static/`, which is the folder to upload.

## 3. Create the Pages project

Run this once:

```bash
npx wrangler pages project create intersection-map
```

Use `main` as the production branch if Cloudflare asks for one.

## 4. Deploy

```bash
npx wrangler pages deploy dist-static --project-name intersection-map
```

After the first deploy, Cloudflare will give you a URL like:

```text
https://intersection-map.pages.dev
```

## 5. Attach the custom domain

In Cloudflare dashboard:

1. Open `Workers & Pages`.
2. Open the `intersection-map` project.
3. Open `Custom domains`.
4. Add `intersection-map.chaosego.com`.

Because `chaosego.com` is already on Cloudflare, the DNS record is usually created automatically.

If Cloudflare asks for a DNS record manually, the subdomain should point to your Pages hostname, for example:

```text
intersection-map.chaosego.com CNAME intersection-map.pages.dev
```

## 6. Remove the old OpenAI mapping

After the Cloudflare Pages version opens correctly:

1. Delete the old DNS record that points `intersection-map.chaosego.com` to `custom-domains.chatgpt.site`.
2. Remove the old custom-domain connection from the OpenAI-hosted site.

## Notes

- The local app remains unchanged.
- Cloudflare Pages serves the static browser app directly.
- No ChatGPT sign-in wall appears on the Cloudflare Pages version.
