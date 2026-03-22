# Boundary Pass IPL Tickets

IPL ticket marketplace built with HTML/CSS/JS frontend + Node/Express backend.

## Run locally

```bash
npm install
npm run dev
```

Open: [http://localhost:3000](http://localhost:3000)

## What is connected

- Live ticket inventory API (mock or external feed)
- Match status API integration (Upcoming / Running / Completed)
- IPL status source defaults to TheSportsDB free feed
- Razorpay checkout integration + demo fallback mode

## API endpoints

- `GET /api/config`
- `GET /api/matches`
- `GET /api/matches/:slug`
- `GET /api/live`
- `GET /api/matches/status`
- `POST /api/checkout/create-order`
- `POST /api/checkout/verify`

## Environment variables

Copy `.env.example` to `.env`:

```bash
PORT=3000
NEXT_PUBLIC_RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
TICKET_FEED_PROVIDER=mock
TICKET_FEED_URL=
TICKET_FEED_BEARER_TOKEN=
MATCH_STATUS_PROVIDER=thesportsdb
SPORTSDB_API_KEY=3
SPORTSDB_IPL_LEAGUE_ID=4460
MATCH_STATUS_REFRESH_MS=60000
```

## Notes

- `MATCH_STATUS_PROVIDER=thesportsdb` pulls match states from TheSportsDB and maps them to local IPL cards.
- If status API fails, the app automatically falls back to schedule-based status inference so UI keeps working.
