# NoteWise

YouTube link → study notes, comprehensive questions (MCQ, short answer, essay) and flashcards.
Includes accounts, free trials, GH₵50/month Mobile Money subscription (manual approval), and an admin panel
to approve payments, manage users, upload textbooks/materials and edit the site.

## Run locally
```bash
npm install
cp .env.example .env     # then fill in ANTHROPIC_API_KEY, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm start
```
Open http://localhost:3000 — log in with your ADMIN_EMAIL to see the **Admin** button.

## How payments work
Customers send the monthly price to the MoMo number set in Admin → Site settings (default 0598429685),
then submit their number + transaction ID. Check your MoMo SMS, then press **Approve** in Admin → Payments.
That adds 30 days. (To automate later, integrate Paystack/Hubtel MoMo and call the same approve logic.)

## Deploy (Render / Railway / VPS)
Needs Node 18+. Set the env vars from `.env.example`. **Attach a persistent disk** and point `DATA_DIR` to it,
otherwise the database and uploaded textbooks are lost on each redeploy.
Only upload materials you have the right to distribute.
