# Email Deliverability — KEN CARTER Store

All transaction email is sent through **Resend** from the store's own domain
(`kencarter.abrdns.com`), so SPF / DKIM / DMARC authenticate the sender instead
of routing through a bare cloud worker domain.

## Sender

The worker defaults its `From` address to:

```
KEN CARTER <noreply@kencarter.abrdns.com>
```

`RESEND_FROM` is optional and, when set, overrides that default. No worker
re-deploy or DNS change is needed to use the default.

## DNS records (already live)

The domain is already pointed at Resend's sending infrastructure. Verified with
`dig` (these resolve through `send.kencarter.abrdns.com`):

| Purpose  | Record                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| SPF      | CNAME `send.kencarter.abrdns.com` → `send.forge.rmta.net`, whose TXT is `v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all` |
| DKIM     | TXT `resend._domainkey.kencarter.abrdns.com` (resolves the `p=` selector key)                                 |
| DMARC    | TXT `_dmarc.kencarter.abrdns.com` → `v=DMARC1; p=none;`                                                        |
| MX (bounce) | `send.kencarter.abrdns.com` → `10 feedback.forge.rmta.net`                                                 |

> The exact `p=` (DKIM key) and selector values are generated per-domain inside
> the Resend dashboard — copy them from the domain verification page rather than
> hand-writing them.

## Verify in the Resend dashboard

1. Open Resend → **Domains** → the `kencarter.abrdns.com` domain.
2. Confirm each checklist item shows **Verified** (SPF, DKIM, DMARC).
3. Send a test email from the dashboard to a Gmail/Outlook address and check:
   - The message lands in the inbox (not spam) and carries the `kencarter.abrdns.com` DKIM pass header.
   - Resend **Logs** show a `delivered` event (no `bounced` / `dropped`).

## Runtime checks

- Delivery emails are dispatched by `sendEmail` with the default `From` above;
  `deliverOrderEmail` records each attempt (and 5-min retry) in the `delivery`
  KV state, which `GET /api/status` surfaces, so you can confirm `sent` per order.
- Keep `RESEND_API_KEY` out of `wrangler.jsonc`. Set it with
  `wrangler secret put RESEND_API_KEY` (or `worker/.dev.vars` locally) —
  plaintext keys in the checked-in config are why delivery was failing before.