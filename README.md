# LibSys

Staff support for Kāpiti Coast Libraries. Staff sign in and ask about Spydus, APNK Monitor, the Bibliotheca self-checks and the printers, or get a Spydus Boolean query written for them. Answers are drawn from the LibSysAIKB knowledge base.

## Pages

| Page | What it's for |
|---|---|
| `index.html` | Support chat, with the urgent contacts in the sidebar |
| `resources.html` | Equipment and supplies at each branch |
| `analytics.html` | Usage, the AI model and fallback, and daily question limits (admins only) |
| `login.html`, `set-password.html` | Signing in, invites and password resets |

## How it fits together

- **Site:** React (chat) and plain HTML pages, built with Vite and published to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main`.
- **Supabase project `ocexpnnzfglknklsotcd`:** sign-in, the tables, and two edge functions, `libsys-chat` (the chat, using OpenRouter's free models) and `SOP-Fetch` (the knowledge base). See [`supabase/README.md`](supabase/README.md).
- **Answers:** when the page loads, [`services/knowledge.ts`](services/knowledge.ts) splits the guides into sections. For each question it sends the AI only the few sections that match, plus the Spydus variables and codes for Boolean queries. The AI's instructions are in [`constants.ts`](constants.ts); the reply rules go last because the weaker free models follow them best there.

## Setting it up

[`GO-LIVE.md`](GO-LIVE.md) has the steps for GitHub Pages, OpenRouter, the Supabase settings and adding staff.

## Setting LibSys up for another library

Kāpiti's Spydus database is shared with other SMART libraries, so the Boolean query help and the Spydus variable and code lookups work for them too. In the Institutions table (INS), Kāpiti Coast is `KCDC`, Carterton is `CTN` and Hutt City is `LP`.

Everything specific to Kāpiti is in one file, [`supabase/functions/_shared/library.ts`](supabase/functions/_shared/library.ts). The prompts, the guide and code search, the sign-in pages and both edge functions read it. It lives there so the edge functions can deploy with it.

| Setting | What it is |
|---|---|
| `name`, `shortName`, `council` | The library's full name, what staff call it ("Kāpiti"), and the council named at the foot of the sign-in pages |
| `emailDomain` | The example address in the sign-in box |
| `institution`, `sharedWith` | The library's code and description in the Institutions table, and the other libraries on the database |
| `branches` | Branch names and their codes in the Location Code table (E), in the order staff see them as buttons |
| `spydus` | The Spydus release the desks run, and the release most Spydus Help guides are written for |
| `systems` | The library's other systems, one line each |
| `contacts` | Who staff are told to contact, and for what (see below) |
| `printer` | The toner colours staff can ask for, and how the ink request email names the cartridge |
| `supabase` | The library's own Supabase project URL and publishable key |
| `siteOrigin` | Where the site is published. The chat only answers pages from there. |
| `guides` | The private GitHub repo the guides come from |

**Changing them on the site:** anyone signed in can change `name` through `printer` for themselves on the **Settings** page ([`settings.html`](settings.html)). Their changes are saved in their own row of the `user_settings` table and only change their own chats. Everything they haven't changed, and everything from `supabase` down, comes from `library.ts`, so `library.ts` is still where the library's usual settings go. [`services/settings.ts`](services/settings.ts) merges the two.

**Who to contact:** the AI's WHO TO CONTACT list is `contacts` in `library.ts`, and on the Settings page. `intro` is the line saying where staff find the numbers, and `list` has one entry per company or team with what they handle, like `{ name: 'Civica', covers: 'bugs or errors in Spydus' }`. Use the names from the **Urgent contacts** list in the sidebar, which is where the phone numbers and hours are kept (the `notes` table, which admins edit on the site). Reply rule 5 in [`constants.ts`](constants.ts) also tells staff their number is in **Urgent contacts**.

To set it up:

1. Copy LibSys into a repo of your own and edit `library.ts`. The institution and branch codes are in your Spydus lookup export (`lkp.json`, tables INS and E).
2. Follow [`GO-LIVE.md`](GO-LIVE.md) with your own Supabase project (run [`supabase/schema.sql`](supabase/schema.sql) in it first), GitHub Pages site, OpenRouter key and guides token.
3. Deploy both edge functions to your project. Each one needs `supabase/functions/_shared/library.ts` deployed with it.
4. Add your urgent contacts and resources on the site, then run `npm test` and `npm run build`.

The guides can be your own repo or a copy of `LibSysAIKB`. The guide search expects its folder layout: `SOP/SPYDUS HELP SOPS`, `SOP/Monitor`, `SOP/APNK` and `SOP/Bibliotheca`, a "Boolean Queries" guide, and `vqd.json` and `lkp.json` for the Boolean queries. The reply rules in [`constants.ts`](constants.ts) and the chat's welcome line also name APNK Monitor and Bibliotheca, so change those if your library uses other systems.

## Working on it

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # chat function tests
npm run build
```
