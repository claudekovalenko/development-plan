# Kovalenko Creatives hub

A private project hub. People sign in through Cloudflare Access (a code sent to their email), pick a project, and see its development plan. Notes, comments, progress checkmarks, weekly updates and ideas are saved in one shared Cloudflare D1 database, so everyone on a project sees everyone's entries. Each person sees only the projects they are a member of; payment terms are shown only to the owner and the project's client.

Version 1 has one project: Jesus People Network (`jpn`).

## Why D1

The hub stores only small, internal project-tracking data (tasks, notes, comments, ideas, weekly updates, and who may see which project). It holds no lead data and is kept fully separate from the Jesus People Network app's leads. One free Cloudflare D1 database keeps it siloed in its own store at $0, next to the Worker that serves it. Supabase/Postgres remains the plan for the lead-generation app's own data.

Known behaviour: unticking a task clears who completed it and when; ticking it again records the new person and date.

## How it fits together

| Path | What it is |
|---|---|
| `src/worker.js` | The Worker. Answers `/api/*` and serves everything else from `public/`. Checks the Access token and the person's membership on every API call. |
| `src/access.js` | Verifies the Cloudflare Access token (signature, audience, issuer, expiry) with WebCrypto. |
| `public/index.html` | The hub page: tabs, progress, comments, updates and ideas. It holds no plan text. |
| `plans/jpn.html` | The Jesus People Network development plan. Outside `public/`, so it is never served as a file: the Worker sends it from `/api/projects/jpn/plan` to owner and core members only. |
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
   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler@4.165.0 deploy
   ```

   The token needs **Workers Scripts: Edit** (and D1 read/write if you load the database with wrangler). Or run the **Deploy the hub** workflow in GitHub Actions, which uses the repository's `CLOUDFLARE_API_TOKEN` secret.
3. **Turn on Access.** In the Cloudflare dashboard: Workers & Pages → `kovalenko-creatives-hub` → the **Access** tab → protect **All traffic**. This covers the workers.dev address and preview URLs. Then edit the Access application it creates:
   - Policy: **Allow**, Include → **Emails** → the member emails (yours and Craig's).
   - Login methods: **One-time PIN** (email code), plus **Google** once it is added (below). People can use either; the Worker only checks the email Access signs in.
   - Copy the application's **Audience (AUD) tag**, and note your team domain (`<team>.cloudflareaccess.com`, shown under Zero Trust → Settings).
   - **Google sign-in** (for Dayne and Josiah; anyone with a Gmail address on the policy can use it), following Cloudflare's [Google guide](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/):
     1. In Google Cloud console, create a project, set up the OAuth consent screen with audience **External**, then **Create OAuth client** → *Web application*.
     2. Authorized JavaScript origin: `https://<team>.cloudflareaccess.com`. Authorized redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
     3. Copy the Client ID and Client secret straight into Cloudflare: **Zero Trust → Integrations → Identity providers → Add new identity provider → Google** (Client ID goes in **App ID**). Save, then select **Test**. The secret stays in Cloudflare; it never goes in this repository or a chat.
     4. In the hub's Access application, tick **Google** under login methods.
4. **Fill in the two Access values** in `wrangler.toml` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`; neither is a secret) and deploy again. Until both are set, every API call answers 401, so the page shows "Please sign in again."
5. **Check it:** open the workers.dev address in a private window. You should get the Cloudflare login, then the plan with its payment section and your name in the top bar.
6. **Retire the old public plan:** stop the GitHub Pages deployment, then make this repository private (GitHub → Settings → Change visibility). The old payment amounts are in this repository's history until it is private.

## Adding a person or a project

- Person: `INSERT INTO members (email, project_id, role, display_name) VALUES ('<their email>', 'jpn', 'core', 'Name');`, with role:
  - `core`: sees the development plan, ticks tasks, posts weekly updates. No payment content.
  - `client`: like a commenter, plus a **Payment Plan** tab with the payment terms. No plan tab, no ticks.
  - `commenter`: sees progress, comments, updates and ideas; can comment and add notes and ideas. No plan tab, no payment content, no ticks.

  Only `owner` and `client` see payment content. Add the same email to the Access policy. Emails are stored in lowercase.
- Project: `INSERT INTO projects (id, name, sort) VALUES ('new-id', 'Project name', 2);` plus its tasks. To give a project a plan, add `plans/<id>.html` and list it in `PLANS` in `src/worker.js`; without one, core members see a placeholder.

## Local testing

```sh
cd hub
node tests/access.test.mjs
node tests/run.mjs   # needs npx (wrangler 4.165.0, pinned) and Playwright with Chromium
```

`tests/run.mjs` uses a throwaway local database with made-up members and made-up private content. Locally, and only on `localhost` with `DEV_USER_EMAIL` set, the Worker accepts an `x-dev-user` header in place of the Access token so the tests can act as different people. Production never sets `DEV_USER_EMAIL`.
