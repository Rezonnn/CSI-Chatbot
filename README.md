# UCSD CSI Chatbot — Short Answers Version (no API key, PDF-safe)

This project is a fully functional chatbot dedicated to the **UC San Diego Center for Student Involvement (CSI)**.

Key behavior:

- Answers each question in **only a few sentences**, focused on what you actually asked.
- Uses only information from the official CSI website (`getinvolved.ucsd.edu`).
- Includes **relevant links** underneath each answer so users can read more if they want.
- Skips PDFs / non-HTML content so responses are clean text (no `%PDF` garbage).

Tech details:

- Crawls **getinvolved.ucsd.edu** from `seeds.json`
- Builds a MiniSearch index of all `text/html` pages
- Detects intents (hours, TAP, advisors, registration, finances, service, CCL, SFL, EDI, jobs)
- Multi-stage fuzzy search + title/section fallback
- Extracts focused snippets around question terms
- Converts the snippet to **2–3 sentences**, then adds a short intro and footer
- Shows up to 3 “Helpful CSI pages” links per answer
- Falls back to the front desk contact only when no relevant info is found

## Run locally

```bash
npm install
cp .env.sample .env      # optional: tweak PORT / MAX_PAGES / contact info
npm start                # Terminal 1: start the server
npm run ingest           # Terminal 2: first crawl / after CSI site updates
```

Then open **http://localhost:3000** and start asking questions like:

- "what are csi front desk hours"
- "how do i fill out a tap form"
- "how can i register my org"
- "funding for my student org slbo"
- "tell me about alternative breaks"
- "fraternity and sorority life at ucsd"
