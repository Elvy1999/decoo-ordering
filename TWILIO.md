Twilio setup for DecoO ordering

1) Create a Twilio account and get credentials
   - TWILIO_ACCOUNT_SID
   - TWILIO_AUTH_TOKEN
   - TWILIO_PHONE_NUMBER (Your Twilio phone in E.164 format, e.g. +15551234567)

2) Set environment variables in your deployment or local .env

3) Install dependency in project root:

```bash
cd decoo-ordering
npm install
```

4) Example .env (do NOT commit):

```
TWILIO_ACCOUNT_SID=your_sid_here
TWILIO_AUTH_TOKEN=your_token_here
TWILIO_PHONE_NUMBER=+15551234567

# existing envs required by the app
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Behavior
- When staff marks an order completed via the staff endpoint, the server will attempt to send an SMS to `customer_phone` on that order.
- Sending is best-effort; failures are logged but do not change API response.
