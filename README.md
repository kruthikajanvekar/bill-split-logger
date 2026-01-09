# Bill Split Logger

Quickly log a bill (photo + notes) and let AI draft the split. Save it now, add it to Splitwise later.

## Features
- Fast log flow: amount, who paid, quick notes, optional photo.
- AI split from notes + receipt image with editable results and math explanation.
- Manual split entry (hidden by default) with preview and totals.
- Works offline first, syncs to Supabase when signed in.
- Google OAuth sign-in + cloud photo backup.
- Swipe to mark bills as completed (archived).
- PWA-ready for fast access on mobile.

## Tech stack
- Vanilla HTML/CSS/JS (no build step)
- IndexedDB for offline storage
- Supabase Auth + Postgres + Storage
- Supabase Edge Function for AI splitting via OpenAI Responses API
- Cloudflare Pages for hosting

## Live
The app is live at `https://bill-split-logger.pages.dev/`.

## Quick start (local)
1) Run a static server:
```bash
python3 -m http.server 8000
```
2) Open `http://localhost:8000`.

This works without auth, but AI splits that call the server require sign-in.

## Supabase setup (Auth + DB + Storage)
Update these constants in `app.js` for your project:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### 1) Create `bills` table
Run in Supabase SQL editor:
```sql
create table if not exists public.bills (
  id text primary key,
  user_id uuid references auth.users not null,
  status text not null default 'open',
  total numeric not null,
  paid_by text,
  notes text,
  items jsonb,
  photos jsonb,
  splits jsonb,
  split_math text,
  split_details jsonb,
  ai_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz
);
```

If upgrading from earlier:
```sql
alter table public.bills
  add column if not exists splits jsonb,
  add column if not exists split_math text,
  add column if not exists split_details jsonb,
  add column if not exists ai_status text;
```

### 2) Enable RLS + policies
```sql
alter table public.bills enable row level security;

create policy "Bills are viewable by owner"
  on public.bills for select to authenticated
  using (auth.uid() = user_id);

create policy "Bills are insertable by owner"
  on public.bills for insert to authenticated
  with check (auth.uid() = user_id);

create policy "Bills are updatable by owner"
  on public.bills for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Bills are deletable by owner"
  on public.bills for delete to authenticated
  using (auth.uid() = user_id);
```

### 3) Storage bucket for photos
Create a **private** bucket named `bill-photos`, then run:
```sql
create policy "Users can view own photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'bill-photos' and owner_id = auth.uid()::text);

create policy "Users can upload own photos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'bill-photos' and owner_id = auth.uid()::text);

create policy "Users can update own photos"
  on storage.objects for update to authenticated
  using (bucket_id = 'bill-photos' and owner_id = auth.uid()::text)
  with check (bucket_id = 'bill-photos' and owner_id = auth.uid()::text);

create policy "Users can delete own photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'bill-photos' and owner_id = auth.uid()::text);
```

## AI splitting
The app supports two modes:
1) **Server AI (recommended for production)**: uses the Supabase Edge Function.
2) **Local key (personal use only)**: stores an OpenAI key in the browser. Do not enable this for public users.

AI splits are disabled until the server is configured or a local key is added. The UI shows status in the AI badge.

### Edge Function: `split-bill`
1) Set the OpenAI key:
```bash
supabase secrets set OPENAI_API_KEY=sk-...
```
2) Deploy:
```bash
supabase functions deploy split-bill
```
Note: `supabase/functions/split-bill/config.toml` sets `verify_jwt = false`, so the function validates tokens itself.

### Auth redirect URLs
After deployment, add your final site URL (Cloudflare Pages) to Supabase Auth redirect URLs.

## Deployment (Cloudflare Pages)
This repo ships with a GitHub Actions workflow at `/.github/workflows/deploy.yml`.

Add these GitHub Secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_PROJECT_NAME`

Push to `main` to deploy.

## Project structure
- `index.html` - UI
- `styles.css` - styling
- `app.js` - app logic
- `manifest.webmanifest`, `sw.js`, `icons/` - PWA assets
- `supabase/functions/split-bill/` - Edge Function for AI splitting

## Contributing
- Keep the app fast and mobile-first; avoid heavy frameworks.
- Maintain offline-first behavior and protect user data.
- Prefer small, focused PRs with clear descriptions.
- Update README if you change setup, data model, or deployment.
- Run a quick UI check locally before opening a PR.

## Roadmap (next work)
1) **Finish AI split reliability**
   - Redeploy `split-bill` and confirm no 401s.
   - Validate AI math explanation is saved to logs.
2) **Splitwise integration**
   - Use Splitwise API to preview and send finalized splits.
   - Add “Send to Splitwise” button on each log.
   - Keep manual edits + swipe to complete as fallback.

## Notes
This is a personal logging tool. It does not sync to Splitwise automatically.
