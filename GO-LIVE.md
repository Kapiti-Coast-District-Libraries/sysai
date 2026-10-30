# Putting the new LibSys live

The new LibSys runs from its own GitHub repo and its own Supabase project (**LibSys**, `ocexpnnzfglknklsotcd`). The old LibSys AI site, its Gemini backend and the shared Supabase project are left exactly as they are.

## 1. GitHub

1. Create a new, empty repo, for example `Kapiti-Coast-District-Libraries/LibSys`. Don't add a README. It needs to be **public** for free GitHub Pages.
2. Push the `new-repo` branch to it as `main`, from this folder. That branch is the current code as one commit, with none of the old repo's history:

   ```bash
   git remote add new https://github.com/Kapiti-Coast-District-Libraries/LibSys.git
   git push new new-repo:main
   ```

   The old history includes a staff phone list and the old shared project's key, so don't push the other branches to the new repo.

3. In the new repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**. The site builds and publishes on every push to `main`, at an address like `https://kapiti-coast-district-libraries.github.io/LibSys/`.

If the repo isn't under `Kapiti-Coast-District-Libraries`, its address starts differently. Set `siteOrigin` in [`supabase/functions/_shared/library.ts`](supabase/functions/_shared/library.ts) to that address and redeploy the `libsys-chat` function, or the chat will be blocked.

## 2. OpenRouter

1. Create an account at [openrouter.ai](https://openrouter.ai).
2. Buy US$10 of credits, once. That raises the free-model limit from 50 to 1,000 requests a day, and free models don't use the credits.
3. In **Settings → Privacy**, allow free endpoints that may train on inputs.
4. Create an API key, and give it a $1 credit limit as a safety net.

## 3. GitHub token for the guides

The knowledge base is read from the private `LibSysAIKB` repo.

1. On GitHub, go to **Settings → Developer settings → Fine-grained tokens → Generate new token**.
2. Set **Resource owner** to `Kapiti-Coast-District-Libraries` and **Repository access** to only `LibSysAIKB`.
3. Under **Repository permissions**, set **Contents** to **Read-only**. Generate it and copy it.

The organisation may need to approve the token before it works.

## 4. Supabase (LibSys project)

1. **Edge Functions → Secrets**, add:

   | Name | Value |
   |---|---|
   | `OPENROUTER_API_KEY` | The key from step 2 |
   | `GITHUB_TOKEN` | The token from step 3 |
   | `SUPPORT_EMAIL` | Your email address. Staff are told to send ink requests and chat histories to it. |

2. **Authentication → Sign In / Providers**: turn off **Allow new users to sign up**.
3. **Authentication → URL Configuration**:
   - Set **Site URL** to the new site's address from step 1.
   - Under **Redirect URLs**, add the same address followed by `set-password.html`, for example `https://kapiti-coast-district-libraries.github.io/LibSys/set-password.html`.
4. **Authentication → Attack Protection**: turn on leaked password protection, if your plan includes it.
5. **Email (needed for invites and password resets):** Supabase's built-in email only reaches people on your Supabase team, a few times an hour. To email staff, go to **Authentication → Emails → SMTP Settings**, turn on custom SMTP, and enter the details for an email service. That could be the council's mail server (ask IT for the host, port, username, password and a sender address) or a service such as Resend or Brevo.

## Adding staff

- **With email set up (step 4.5):** go to **Authentication → Users → Add user → Send invitation**, and enter their email. They get a link, choose their own password, and land in LibSys.
- **Without it:** go to **Add user → Create new user**, enter their email and a temporary password, tick **Auto Confirm User**, and give them the password. They can change it under **Change password** in the sidebar.

Anyone who forgets their password can use **Forgot your password?** on the sign-in page. This only works once email is set up.

## 5. Admin

Admins are the rows in the `app_admins` table. Only admins see the **Usage** page. To add one, run this in the Supabase SQL editor with their email:

```sql
insert into public.app_admins (user_id)
select id from auth.users where email = 'name@kapiticoast.govt.nz';
```

To remove one, delete their row.

**Daily limits:** set them on the Usage page. There's a default for everyone, and a personal limit for anyone who needs more or less. Leave a box blank for no limit. The count resets at midnight New Zealand time, and failed requests don't count.

## 6. Before you announce it

1. **Final copy:** the old site keeps logging usage and contact edits in the old project until staff move over. Copy anything new across just before you switch.
2. **Test:** open the new site, sign in, ask a question, try an ink request, and check **Resources** and **Usage**.
3. **Tell staff the new address.** They use the same email and password as before.
