# G Maps Crawl agent skills

Installable `google-maps-data` skill for public Google Maps business research through the hosted MCP server, with a dependency-free Node.js REST fallback. Inspired by the Glade agent-skills package structure.

## Install

```bash
npx skills add ricciflow-api/gmapscrawl-agent-skills
```

Or copy `skills/google-maps-data` into your agent client's supported skills directory. The entry point is `skills/google-maps-data/SKILL.md`.

## Configure

Connect [G Maps Crawl MCP](https://github.com/ricciflow-api/gmapscrawl-mcp) at `https://gmapscrawl.com/api/mcp`. For the REST fallback, supply `GMSCRAPER_API_KEY` using your secret environment, then run:

```bash
node skills/google-maps-data/scripts/gmapscraper-request.mjs examples/search.json
```

Generate a new `client_request_id` for a new search; preserve it with unchanged inputs on a retry. The helper performs one bounded request and prints JSON. Follow accepted jobs with `jobs.get`, then `jobs.results`.

Start with a test key: results are simulated and consume zero units. The published service skill currently labels paid API/MCP new-work unavailable. Never infer live capability from the operation catalog. See [availability](https://docs.gmapscrawl.com/concepts/availability).

## Included

- `SKILL.md`: MCP-first workflow, bounded scope, job completion, and error handling.
- `references/`: public operation schemas and normalized result semantics.
- `scripts/gmapscraper-request.mjs`: rejects redirects, limits response size and duration, validates inputs, and keeps keys in headers.
- `tests/`: offline request construction, rejection, output redaction, and response limits.

## Validate

```bash
npm test
```

Requires Node.js 22 or newer. No package installation is needed for the tests or helper.

[Documentation](https://docs.gmapscrawl.com) · [MCP](https://github.com/ricciflow-api/gmapscrawl-mcp) · [MIT license](LICENSE)
