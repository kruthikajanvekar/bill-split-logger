# Bill Split Logger — Agent Guide

## Mission
Build a fast, phone-friendly web app to log bills quickly with photos, items, people, and totals, then mark them as completed after they’re added to Splitwise.

## Product Principles
- Speed first: minimal taps, big touch targets, one-screen logging.
- Offline-friendly: usable without network; data stored locally.
- Optional cloud sync: Google OAuth via Supabase for signed-in users, including photo backups.
- Low/no cost: static hosting only; no paid services.
- Privacy-first: data stays in the browser.

## Scope & Features
- Create a bill entry with:
  - Total amount
  - Date/time (default now)
  - Notes
  - Optional bill photos
  - Item rows (description, person, optional exact amount)
  - Split instructions + AI-generated splits (editable)
- List view with quick filters (Open / Completed).
- Swipe-to-complete on mobile (with fallback button).
- Undo for accidental dismissals.
- PWA installability for fast phone access.

## Tech Decisions
- Vanilla HTML/CSS/JS (no build step).
- IndexedDB for entries + photo blobs, Supabase for optional cloud sync + storage.
- AI split runs via Supabase Edge Function for public use; local key fallback for personal use. Require auth for server calls and queue pending splits on next app open.
- Service worker for offline cache.
- Static hosting (GitHub Pages / Netlify / Cloudflare Pages).

## Local Dev
- Open `index.html` directly in a browser or use a simple static server.
- No build command required.

## Files
- `index.html`: UI + app shell
- `app.js`: logic, IndexedDB, gestures
- `styles.css`: UI + mobile styling
- `sw.js`: service worker
- `manifest.webmanifest`: PWA manifest

## Data Model (IndexedDB)
- Object store: `bills`
- Key: `id` (UUID)
- Fields: `status`, `createdAt`, `updatedAt`, `total`, `paidBy`, `notes`, `items[]`, `photos[]`, `splits[]`, `splitMath`, `splitDetails`, `aiStatus`, `syncedAt`

## UX Conventions
- Primary action: “Save Bill”.
- One-tap add item row.
- Swipe left/right on a bill card to mark completed.
- Snackbars for success/undo.

## Deployment
- Static hosting only. Prefer GitHub Pages if repo exists, or Netlify/Cloudflare Pages.
- If needed, add a `CNAME` later for custom domains.

## Testing Checklist
- Create/edit/delete entries
- Add multiple photos
- Swipe to complete + undo
- Offline reload with cached assets
- Mobile layout in narrow widths

## Session Context (2026-01-04)
- Focus: Fix AI splitting auth (401), streamline AI settings UI, and keep the app shippable.
- Current state: AI badge sits in Cloud sync header; AI key lives under Cloud sync; auth header now sends `Authorization`.
- Edge function updated to accept `authorization` or `Authorization` headers.

## Resume Info
- Local terminal session id: `w0t0p0:F7C66965-33C4-4AC0-ABEE-2CE58E8E1A22`
- Codex conversation id is not exposed in the environment.
- Resume command:
  - `cd /Users/suraj/Desktop/bill-split-logger`
  - Start Codex in this repo (same way as usual).

## Next Work Plan (in order)
1) **Get AI splitting fully working**
   - Redeploy the `split-bill` edge function.
   - Confirm the function returns 200 with a valid auth token.
   - Verify AI toggle, split preview, and math explanation on a signed-in user.
2) **Splitwise API integration**
   - Use Splitwise API to preview logs and send the final split when approved.
   - Include a “Send to Splitwise” CTA in each log.
   - Keep manual edits + swipe-to-complete as fallback.

## Primary User Flow
Restaurant → take photo + enter total + notes → save → AI splits with math → later review/adjust → send to Splitwise → swipe to complete.
