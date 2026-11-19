# Kovalenko Creatives hub

A private project hub. People sign in through Cloudflare Access (a code sent to their email), pick a project, and see its development plan. Notes, comments, progress checkmarks, weekly updates and ideas are saved in one shared Cloudflare D1 database, so everyone on a project sees everyone's entries. Each person sees only the projects they are a member of; owner-only content such as payment terms is shown only to that project's members.

Version 1 has one project: Jesus People Network (`jpn`).

## How it fits together

| Path | What it is |
|---|---|
| `src/worker.js` | The Worker. Answers `/api/*` and serves everything else from `public/`. Checks the Access token and the person's membership on every API call. |
| `src/access.js` | Verifies the Cloudflare Access token (signature, audience, issuer, expiry) with WebCrypto. |
| `public/index.html` | The hub page (the development plan with its tabs). |
| `public/_headers` | Security headers for the page. |
| `schema.sql` | The database tables. |
| `seed.sql` | The `jpn` project, its task list and the built-in weekly updates. No emails, no payment content. |
| `wrangler.toml` | Worker settings: name, D1 binding, the two Access values. |
| `tests/` | `node tests/access.test.mjs` (token checks) and `node tests/run.mjs` (runs the Worker locally with a local D1 and drives the page). |

Member emails and payment content are **not** in this repository. They are loaded at setup from two private files kept outside it:

- `members.sql`: who can sign in, and to which projects (`project_id = '*'` means every project).
- `jpn-private.sql`: rows for the `project_private` table, keyed `payment-section`, `toc-total`, `stage-1-amount`, `stage-2-amount`, `stage-3-amount` and `agreement-payment`.

If you keep copies next to this file, put them in `hub/private/`; `.gitignore` excludes that folder.

## Setup

The D1 database `kovalenko-creatives-hub` already exists (its id is in `wrangler.toml`).

1. **Load the database** (Cloudflare connector, dashboard D1 console, or wrangler with `--remote`), in this order:
   1. `schema.sql`
   2. `seed.sql`
   3. the private `members.sql`
   4. the private `jpn-private.sql`
2. **Deploy the Worker** from this folder:

   ```sh
   cd hub
   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler@4 deploy
   ```

   The token needs **Workers Scripts: Edit** (and D1 read/write if you load the database with wrangler). Or run the **Deploy the hub** workflow in GitHub Actions, which uses the repository's `CLOUDFLARE_API_TOKEN` secret.
3. **Turn on Access.** In the Cloudflare dashboard: Workers & Pages → `kovalenko-creatives-hub` → the **Access** tab → protect **All traffic**. This covers the workers.dev address and preview URLs. Then edit the Access application it creates:
   - Policy: **Allow**, Include → **Emails** → the member emails (yours and Craig's).
   - Login method: **One-time PIN** (email code).
   - Copy the application's **Audience (AUD) tag**, and note your team domain (`<team>.cloudflareaccess.com`, shown under Zero Trust → Settings).
4. **Fill in the two Access values** in `wrangler.toml` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`; neither is a secret) and deploy again. Until both are set, every API call answers 401, so the page shows "Please sign in again."
5. **Check it:** open the workers.dev address in a private window. You should get the Cloudflare login, then the plan with its payment section and your name in the top bar.
6. **Retire the old public plan:** stop the GitHub Pages deployment, then make this repository private (GitHub → Settings → Change visibility). The old payment amounts are in this repository's history until it is private.

## Adding a person or a project

- Person: `INSERT INTO members (email, project_id, role, display_name) VALUES ('<their email>', 'jpn', 'member', 'Name');` and add the same email to the Access policy. Emails are stored in lowercase.
- Project: `INSERT INTO projects (id, name, sort) VALUES ('new-id', 'Project name', 2);` plus its tasks. The page shows the Jesus People Network plan only for `jpn`; other projects get the shared tabs and a placeholder plan for now.

## Local testing

```sh
cd hub
node tests/access.test.mjs
node tests/run.mjs   # needs npx (wrangler@4) and Playwright with Chromium
```

`tests/run.mjs` uses a throwaway local database with made-up members and made-up private content. Locally, and only on `localhost` with `DEV_USER_EMAIL` set, the Worker accepts an `x-dev-user` header in place of the Access token so the tests can act as different people. Production never sets `DEV_USER_EMAIL`.
