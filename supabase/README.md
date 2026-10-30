# Supabase

LibSys has its own Supabase project, **LibSys** (`ocexpnnzfglknklsotcd`, Sydney, free plan). It was set up on 28 October 2026 so LibSys no longer shares a database with other library systems.

## What's in it

- **Staff accounts:** the 11 accounts from the shared project, copied with the same IDs and passwords. Staff sign in with the same details, but have to sign in again once, because it's a new project.
- **Tables:** the tables in [`schema.sql`](schema.sql). Row-level security is on from the start, and the public key alone can't read or change anything.
  - `notes` (urgent contacts) and `resources`: copied over. Everyone signed in can read them; only admins (`app_admins`) can change them.
  - `Useage`: copied over. Only `log_rpd` writes to it, and only for the signed-in caller.
  - The usage page reads staff emails and usage through admin-only functions (`admin_user_emails`, `admin_usage` and the limit functions), which refuse anyone who isn't in `app_admins`.
  - `model_usage`: which free model answered each question.
  - `app_admins`: who can see the Usage page. Add or remove a row to change admins.
  - `request_limits` and `app_settings`: daily question limits, set on the Usage page. The chat function checks them before each question.
  - `kb_cache`: which `LibSysAIKB` commit the cached guides were built from. Only `SOP-Fetch` uses it.
- **Storage:** the private `knowledge-base` bucket holds the cached guides as gzipped JSON. Only `SOP-Fetch` can read or write it.
- **Functions:**

| Function | What it does | Verify JWT |
|---|---|---|
| [`libsys-chat`](functions/libsys-chat) | The chat. Checks the sign-in, asks the main free model set on the Usage page (then its fallback), turns ink and chat-history requests into emails to the LibSys admin, and logs the model used. | Off, because the code checks the sign-in |
| [`SOP-Fetch`](functions/SOP-Fetch) | Sends the `LibSysAIKB` guides to signed-in staff. It builds them once per commit, keeping only the files the app reads (no PDFs), and serves the cached copy. Every 5 minutes one page load asks GitHub for the latest commit and rebuilds in the background if it has changed, so guide edits show up within about 5 minutes. | Off, because the code checks the sign-in |

Both functions import [`functions/_shared/library.ts`](functions/_shared/library.ts), the library settings: the site address the chat answers, the ink request wording and the guides repo. The Supabase CLI deploys it with them. When deploying another way, include it as `../_shared/library.ts`.

## Finish the setup

Add these in the LibSys project under **Edge Functions → Secrets**:

| Secret | What it is |
|---|---|
| `GITHUB_TOKEN` | A GitHub token that can read the private `LibSysAIKB` repo. Use the same one as the shared project's `SOP-Fetch`, or make a new read-only one. Without it the guides don't load. |
| `OPENROUTER_API_KEY` | From [openrouter.ai](https://openrouter.ai). Buy US$10 of credits once to get 1,000 free-model requests a day, allow free endpoints that may train on inputs under **Settings → Privacy**, and give the key a $1 credit limit. Without it the chat says it isn't set up yet. |
| `SUPPORT_EMAIL` | The LibSys admin's email address. Ink requests and chat histories come back as an email for staff to copy, and this is the address they're told to send it to. Without it they're told "your LibSys admin". |

Then, in the dashboard:

- **Auth → Sign-ups:** turn off public sign-ups, since staff accounts are made by hand.
- **Auth → Passwords:** turn on leaked password protection.
- **Auth → URL configuration:** set the site URL to the new site's address.

Then follow [`../GO-LIVE.md`](../GO-LIVE.md) to publish the site from its new repo.

Free projects pause after a week with no activity. Daily use keeps it awake. If it does pause, restore it from the dashboard.

## Adding a staff member

See [Adding staff](../GO-LIVE.md#adding-staff). Invites and password resets need custom SMTP; without it, create users with a temporary password.

## Choosing the AI model

Admins pick a **main model** and a **fallback** under **AI model** on the Usage page. The list is OpenRouter's free models, fetched live each time the page opens, so new ones appear and withdrawn ones drop off. Either can be the free router, which picks a free model for each question. Each question goes to the main model first; if it fails, is busy or sends back nothing, the fallback gets one try.

- Only free models can be saved (`admin_set_chat_models` refuses anything else), so the chat can't spend the OpenRouter credit.
- If a saved model is withdrawn, questions still get answered by the fallback, and the Usage page says to pick another. Keeping the free router as the fallback means there's always one that works.
- Models marked "can't do ink requests" don't support tool calls, so ink requests and chat-history emails only work when the fallback answers.
- With nothing saved, the chat uses the `OPENROUTER_MODEL` secret if set, otherwise the free router.

## Which models answered

```sql
select model, count(*) as questions, count(*) filter (where error is not null) as errors
from model_usage
where created_at > now() - interval '7 days'
group by model
order by questions desc;
```

The 1,000-a-day limit resets at midnight UTC: midday in New Zealand, or 1pm during daylight saving.

## The old setup

The old LibSys AI site, its Gemini backend and the shared Supabase project are separate from this one and are left as they were.

## Tests

```bash
npm test
```

These test the chat and SOP-Fetch functions' logic with Supabase, OpenRouter and GitHub stubbed, so they need no accounts.

## Rebuilding the cached guides

SOP-Fetch rebuilds the guides by itself when `LibSysAIKB` gets a new commit. To force a rebuild at the next page load, for example after changing which files it keeps, bump `BUILD` in [`kb.ts`](functions/SOP-Fetch/kb.ts) and deploy, or run:

```sql
update kb_cache set build = null, checked_at = null where id = 1;
```
