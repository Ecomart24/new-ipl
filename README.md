# Viagoco IPL Tickets

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
- SabPaisa checkout integration with production-safe URL validation

## API endpoints

- `GET /api/config`
- `GET /api/matches`
- `GET /api/matches/:slug`
- `GET /api/live`
- `GET /api/matches/status`
- `POST /api/checkout/create-order`
- `POST /api/checkout/verify`
- `POST /api/checkout/sabpaisa/response` (gateway callback, legacy path)
- `POST /api/payments/sabpaisa/callback` (gateway callback, preferred path)
- `POST /api/payments/sabpaisa/webhook` (gateway webhook alias)
- `POST /api/checkout/ccavenue/response` (gateway callback)

## Environment variables

Copy `.env.example` to `.env`:

```bash
PORT=3000
CHECKOUT_PROVIDER=sabpaisa
NEXT_PUBLIC_RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
APP_BASE_URL=https://viagoco.com
SABPAISA_BASE_URL=https://securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=1
SABPAISA_MERCHANT_ID=
SABPAISA_CLIENT_CODE=
SABPAISA_USERNAME=
SABPAISA_PASSWORD=
SABPAISA_KEY=
SABPAISA_IV=
SABPAISA_ENV=prod
SABPAISA_CHANNEL_ID=web
SABPAISA_CALLBACK_URL=https://viagoco.com/api/payments/sabpaisa/callback
SABPAISA_SUCCESS_URL=https://viagoco.com/payment/success
SABPAISA_FAILURE_URL=https://viagoco.com/payment/failure
SABPAISA_WEBHOOK_URL=https://viagoco.com/api/payments/sabpaisa/webhook
SABPAISA_DEBUG=false
CCAVENUE_MERCHANT_ID=
CCAVENUE_ACCESS_CODE=
CCAVENUE_WORKING_KEY=
CCAVENUE_ENV=test
CCAVENUE_REDIRECT_BASE_URL=
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
- `APP_BASE_URL` is the single source of truth for live SabPaisa redirects and callbacks.
- Production checkout is blocked if SabPaisa URLs point to localhost, an IP address, or preview hosts.
- Use `https://viagoco.com/api/payments/sabpaisa/callback` as the preferred SabPaisa callback URL for whitelisting.
- Set `CHECKOUT_PROVIDER=razorpay` only when you want Razorpay as primary gateway.
- Set `CHECKOUT_PROVIDER=ccavenue` only when you want CCAvenue as primary gateway.
- For CCAvenue callbacks in production, set `CCAVENUE_REDIRECT_BASE_URL` to your public HTTPS base URL.


