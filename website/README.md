# Nginx Complete Guide — website

Next.js docs site built from the markdown notes in the parent folder (`../01_Fundamentals`, `../02_Real-World-Scenarios`, `../interview-questions`, root `README.md` / `WEB-SERVER-GUIDE.md`). Notes are read at build time; every page is prerendered.

- `npm run dev` / `npm run build` / `npm start`
- `npx vitest run` — loader tests against the real notes
- Languages: `name.md` is English; `name.hinglish.md` and `name.hi.md` next to it add Hinglish / Hindi tabs.
- Vercel: Root Directory = `website`.
- Docker (from this folder): `docker compose up --build` (build context is the repo root).
