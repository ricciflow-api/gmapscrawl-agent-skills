# G Maps Crawl agent skill

Install `skills/google-maps-data` in your agent’s skill directory. Connect
`https://gmapscrawl.com/api/mcp` or inject `GMSCRAPER_API_KEY` for the REST helper.
The skill uses one synchronous search tool and returns up to 20 businesses per
request. It includes pagination (pages 1–10), safe retries, and untrusted-data
handling. No job polling, exports, or webhooks are needed.

```bash
node skills/google-maps-data/scripts/gmapscraper-request.mjs examples/search.json
npm test
```

The request helper sends POST `/api/v1/search`. One accepted live search page
uses one request unit; test-key responses are simulated and non-billable.
See [the skill](skills/google-maps-data/SKILL.md) and
[the docs](https://docs.gmapscrawl.com/quickstart).

Enriched searches may reuse Maps details for up to 730 days. Completed query
responses retain a 24-hour window (1 hour for empty results), and website
contact checks have a 7-day window.
Inspect `place.observedAt`, `place.contactsCheckedAt`, and contact observation
timestamps to assess the age of reused records. Use `extra: true` for
email/social enrichment. Preserve the identifier and arguments when retrying
the same request.
See [data freshness](https://docs.gmapscrawl.com/concepts/freshness).
