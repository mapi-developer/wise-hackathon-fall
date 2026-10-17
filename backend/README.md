# Unbound backend

FastAPI + SQLModel (Postgres) + RustFS (S3) + Google Gemini, Anthropic Claude or a local model (LM Studio).
See the [root README](../README.md) for running and deploying.

```bash
docker compose up -d --build                     # from the repo root: API, worker, Postgres, storage
```

Settings live in the repo-root `.env` (see `.env.example`): `GOOGLE_CLIENT_ID`, `JWT_SECRET`, and an
AI key. Without an AI key the app still runs; chat and document analysis report that the assistant
isn't configured. Optional: `GUIDELINE_MAX_AGE_DAYS` (default `90`).

### AI provider

| | Gemini | Claude | Local (`LLM_PROVIDER=local`) |
| --- | --- | --- | --- |
| Key | `GEMINI_API_KEY` ([AI Studio](https://aistudio.google.com/apikey)) | `ANTHROPIC_API_KEY` | none (`LOCAL_LLM_API_KEY` if the server needs one) |
| Model | `GEMINI_MODEL` (default `gemini-3.5-flash`) | `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `AGENT_EFFORT` (default `high`) | `LOCAL_LLM_MODEL` (default `qwen3-4b-instruct-2507`) at `LOCAL_LLM_URL` (default `http://host.docker.internal:1234/v1`) |

List the Gemini models your key can use (the current one is starred):
`docker exec unbound_backend python -m app.cli.list_models`. Not every listed model works on every
key: previews may have no free quota (429), and some need the API enabled in the key's Google Cloud
project (403).

`LLM_PROVIDER=gemini|anthropic|local` picks one; unset, Gemini is used when `GEMINI_API_KEY` is set. After
changing `.env`, recreate the container: `docker compose up -d backend`. Conversations remember the
provider they started with (message formats differ); switching providers means starting a new
conversation. Tools, rules, the guideline gate and the UI are the same for both.

**Local model (LM Studio).** Any OpenAI-compatible server works; nothing leaves the machine. Load
the model in LM Studio, then start its server where the containers can reach it (the Docker bridge
address, not your network):

```bash
~/.lmstudio/bin/lms server start --port 1234 --bind 172.17.0.1
```

The containers reach it as `host.docker.internal` (mapped in both compose files for local use).
- **Chat**: tool calling through the same tools; the history is stored in OpenAI message format.
  Malformed tool arguments are answered with an error instead of being run.
- **Documents**: PDFs with a text layer are read as text, and the MRZ is taken from that text by
  code (small models garble long strings), then checked as usual. Photos and scans need a vision
  model (`LOCAL_LLM_MODEL` set to one); with a text-only model the user is told to upload a text PDF.
- **Pipeline**: extraction uses the local model with the same schema; `verify.py` still drops
  anything whose quote isn't on the page. Web discovery needs Gemini (Google Search) and is skipped.

A 4B model follows tools and schemas but is weaker at judgement (it may answer from general
knowledge instead of calling a tool). Facts that matter still come only from tools and verified
guidelines.

**Free-tier data:** on Gemini's free tier Google may use what you send, including document scans, to
improve its products. Use a paid Gemini key (or Claude) before real users upload documents.

## Agents

```
           user message (optionally about a journey)
                │
        ┌───────▼────────┐  tools (app/agents/tools.py)        deterministic code
        │  Chat agent    │──► get_my_case                   rules.py: dates, MRZ check digits,
        │ orchestrator.py│──► get_country_guidelines ──┐    validity windows, exact fee sums,
        └───────┬────────┘──► check_my_documents      │    gap check, form filling
                │          ──► create_journey / get_journey / update_journey / set_step_done
                │          ──► prefill_form, update_my_profile      journeys.py: pathway, money,
                │                                      │            automation, calendar
                │                     guidelines.py: freshness gate
                │                     current → content · stale/missing → "being updated soon"
        ┌───────▼────────┐
        │ Document agent │  queued on every upload, run by the worker: the model reads the file
        │  documents.py  │  into a fixed schema, values as printed → rules.normalize_extraction
        └────────────────┘  → document_analyses (fields, issues, MRZ verified or not)
```

What the model does and doesn't decide:

- **The model** talks with the user, chooses tools, and reads documents into raw strings.
- **Code** decides everything with legal or numeric weight: whether a guideline may be used,
  date parsing (ambiguous `03/04/2027` is reported, never guessed), passport MRZ check digits,
  "valid N months after the trip", document age, minimum amounts, fee totals (`Decimal`, per
  currency), task due dates, and form values. A constraint whose input is unknown is a problem,
  not a pass.
- **Stale guidelines are withheld in code.** When an entry is unverified, older than
  `GUIDELINE_MAX_AGE_DAYS` (pipeline entries: `PIPELINE_MAX_AGE_DAYS`), or past its `valid_until`, the tools return only a "not up to date"
  status, so the model has nothing outdated to repeat. The system prompt tells it to say the
  country's information is being updated and will be available soon.

Chat history is stored append-only in `chat_messages`, exactly as exchanged with the API (thinking
blocks replay unchanged). Replies stream to the browser as server-sent events from
`POST /api/chat/sessions/{id}/messages`: `text`, `tool` (start/done/error), `done` (which data
changed) and `error`.

## Journeys

A journey is one trip or move. The assistant creates it with `create_journey`; the user then works
through it in the app, marks steps done, reopens it later, or continues it with a next leg
(`parent_id`). Stored: the journey and its pathway (tasks with `journey_id`, documents first, then
the application steps, with due dates counted back from the travel date). Computed live every time
it's read (`app/agents/journeys.py`), so it never goes stale:

- **Documents needed:** each requirement checked against the user's documents; a document that
  satisfies one ticks its pathway step.
- **Money:** the standard fee total per currency, alternative fees (by way of applying or applicant
  group: you pay one), what's paid and left, proof of funds against savings, living costs at the
  user's budget.
- **Automation:** prefill forms, pay fees (simulated Wise; no money moves), download the deadlines as
  a calendar file, drafted emails to whoever issues a missing document, and uploads.

Conversations can belong to a journey (`chat_sessions.journey_id`); the agent then works on it.

## Application forms

`app/forms/`. Prefilling a form (from a journey, or by the agent with `prefill_form`) fills its
fields from the passport analysis, the latest analysis of each other document (accommodation,
enrolment, employment contract, insurance), the profile and the journey; each value records where it
came from. Nothing is guessed: a value that couldn't be read stays empty. The user can correct any
field (`PATCH /api/forms/{id}`), and then downloads:

- **The official form, filled in** (`GET /api/forms/{id}/official.pdf`): for the EU Schengen visa
  application and the Hungarian residence permit application (OIF form 9). The official PDFs aren't
  fillable, so `pdf.py` finds each field's printed label on the page (pdfplumber), writes the value
  next to it on an overlay (reportlab, DejaVu font, so accents and Cyrillic work) and merges it
  onto the original (pypdf). Placements are anchored to labels, not coordinates (`templates.py`); a
  label that isn't found, or a gap too small for the value, is skipped rather than written over the
  form, and listed in the `X-Unplaced-Fields` header. The PDF is fetched from its official page
  (allowlisted domains only), cached for a day and kept in storage in case the site is down.
- **A data sheet** (`GET /api/forms/{id}/datasheet.pdf`): every field, its value and its source, for
  forms that are submitted online.

Checkboxes that would need a guess (passport type, first application) are left for the applicant.

## Guidelines pipeline (daily)

`app/pipeline/`, run by the worker once a day (and on demand from **Data sources** in the app, for
`ADMIN_EMAILS`). For each target in `targets.py` (Hungary: tourism, study, work, job search, family,
any citizenship):

1. **Fetch** the official seed pages, plus pages found by web search (Gemini with Google Search),
   which are kept only if they resolve to an allowlisted official domain (`fetch.ALLOWED_DOMAINS`).
   HTTPS with verified certificates only, `robots.txt` respected, one request per second per host.
   Every page is stored as a snapshot.
2. If the pages are unchanged since the published version, **re-verify** its quotes in code and
   refresh `verified_at`; no model call.
3. Otherwise **extract**: the model reads the pages and proposes requirements, fees and steps, each
   with evidence (source URL + verbatim quote in the original language).
4. **Verify** (`verify.py`, no model): a fact is kept only if its quote is found on that page as
   fetched, and every number it states (amounts with their currency, months, days) appears in that
   quote. Unproven constraints and deadlines are removed; unproven items are dropped and logged.
5. **Publish or hold**: published only if at least 3 requirements survive and no more than 40% were
   lost compared with the previous version; otherwise the previous entry stays.

Pipeline entries count as current for `PIPELINE_MAX_AGE_DAYS` (default 3). If the pipeline keeps
failing past that, agents stop using the entry and tell users the country is being updated.

Manual entries can still be loaded with the importer (validated against `app/agents/schema.py`):

```bash
docker exec -w /app unbound_backend python -m app.cli.import_guidelines data/guidelines/ --dry-run
```

`data/guidelines/hu-from-ru-tourism.json` is an unverified draft from early development, superseded
by the pipeline's entries.

## Worker

`python -m app.worker` (its own container): document analysis queue (claims pending analyses from
the database, so uploads are analysed even across restarts) and the pipeline schedule. A Postgres
advisory lock keeps the pipeline to one run at a time.

## Explore map (visa eligibility)

`GET /api/explore/map` colours every country for one passport, residence permit and purpose;
`GET /api/explore/countries/{code}` explains one. Both default to the user's profile
(`nationality_code`, `residence_code`, `travel_purpose`); `?origin=&residence=&purpose=` explore "what if"
without saving. Favourites: `GET/POST /api/explore/favorites`, `DELETE /api/explore/favorites/{code}`.

`app/explore.py` decides, in this order: own country or residence country → rules (EU/EEA/Swiss free
movement; a Schengen residence permit for short Schengen trips) → a **current** guideline with an
`entry_type` → the indicative matrix (tourism only) → unknown. Stale guidelines are withheld here too.
The passport country comes from the profile, else the analysed passport's MRZ nationality, else the
citizenship text.

The indicative matrix is the open Passport Index dataset (MIT), bundled in `data/visa-matrix/` as of
2025-01-12 and loaded into `visa_requirements` on first start. It is never presented as verified. To
colour a country from your own data, give its guideline an `entry_type`
(`visa_free | visa_on_arrival | evisa | visa_required`) and verify it.

The country endpoint also returns `routes` (ways in: visa-free, on arrival, eVisa/ETA, apply for a
visa, or a Schengen residence permit) and, when entry needs more than a passport, `alternatives`:
nearby countries ranked visa-free first, then visa on arrival, then eVisa, nearer first (a harder
status counts as 1,500 km extra). Distances use rough country centres in `data/geo/centroids.json`
(Natural Earth 1:110m, the same shapes as the globe). The chat agent gets the same ranking through
the `find_destinations` tool, with map links.

## Finances

`GET /api/finances` gives every open journey's fees (from its guideline, each marked paid or not),
paid and remaining totals, proof of funds and living costs, plus totals across journeys. Amounts are
exact decimal strings per currency and are never converted or added across currencies.

## Tests

```bash
docker exec -w /app unbound_backend python -m pytest -q tests/
```

- `test_rules.py`: dates, MRZ, fees, requirement checks, form fill.
- `test_explore.py`: explore map eligibility precedence, country-code parsing, the bundled visa matrix.
- `test_local_documents.py`: the MRZ read from a PDF's text layer.
- `test_forms_pdf.py`: values land next to their labels, missing labels and tight gaps are skipped,
  every form placement refers to a real field, the data sheet renders Unicode.
- `test_verify.py`: quote matching, amounts and currencies, dropping unproven facts, publish rules.
- `test_integration.py` (real database, no model calls): the journey lifecycle (pathway, finances,
  automation, payments, prefill, rescheduling, complete and reopen, next leg, calendar, stale
  guideline, isolation) and the pipeline (publish, re-verify without the model, hold, failure).
