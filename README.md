# Unbound

Plan a trip or move abroad with an AI assistant, then follow it step by step: the documents you need, what it costs, every step with its deadline, and what Unbound can do for you (prefill application forms from your documents and download them as filled-in official PDFs, pay fees, calendar reminders, document requests). Immigration rules come from official government pages, re-checked every day.

**Explore** shows a 3D globe of where your passport lets you go (verified guidelines first, an open
visa dataset as an indicative fallback, always labelled with its source). The app is in English,
Hungarian and Russian.

```
frontend/   React + Vite + Tailwind (served by nginx in production)
backend/    FastAPI API, AI agents, guidelines pipeline, worker
deploy/     Caddyfile (HTTPS) for production
```

**Contents:** [Architecture](#architecture) · [Core principle](#core-principle-the-model-talks-code-decides) ·
[Chat agent](#chat-agent) · [Journeys](#journeys) · [Documents](#document-analysis) ·
[Guidelines pipeline](#guidelines-pipeline) · [Explore](#explore-map) · [Data model](#data-model) ·
[Run locally](#run-locally) · [Deploy](#deploy-one-server)

---

## Architecture

```mermaid
flowchart LR
    user(["👤 User<br/>browser"])

    subgraph edge["Production edge"]
        caddy["Caddy<br/>HTTPS · auto certs"]
        nginx["nginx<br/>built React app"]
    end

    subgraph app["Application"]
        fe["Frontend<br/>React + Vite + Tailwind<br/>EN · HU · RU"]
        api["Backend API<br/>FastAPI · SQLModel<br/>:8000"]
        worker["Worker<br/>python -m app.worker"]
    end

    subgraph data["Data"]
        pg[("PostgreSQL<br/>users · journeys · tasks<br/>guidelines · chats")]
        s3[("RustFS / S3<br/>uploaded documents")]
    end

    subgraph ai["AI provider — one of"]
        gemini["Google Gemini"]
        claude["Anthropic Claude"]
        local["Local model<br/>LM Studio · OpenAI API"]
    end

    gov["🏛️ Official government<br/>web pages"]
    google["Google OAuth"]

    user --> caddy --> nginx --> fe
    fe -- "REST + SSE /api" --> api
    fe -- "Sign in" --> google
    api -- "verify ID token" --> google
    api --> pg
    api --> s3
    api -- "chat agent" --> ai
    worker --> pg
    worker --> s3
    worker -- "document agent<br/>pipeline extraction" --> ai
    worker -- "daily fetch" --> gov
```

| Service | Role |
| --- | --- |
| **Frontend** | SPA: landing, wizard, assistant chat, journeys, documents, to-do, finances, forms, explore globe, admin data sources |
| **Backend API** | Auth (Google → JWT), REST resources, chat streamed over Server-Sent Events |
| **Worker** | Document analysis queue + daily guidelines pipeline (one at a time via a Postgres advisory lock) |
| **PostgreSQL** | All application state, including the verified country guidelines |
| **RustFS** | S3-compatible storage for uploaded passports, certificates, etc. |
| **AI provider** | Picked with `LLM_PROVIDER` (`gemini`, `anthropic`, `local`); everything above it is provider-independent |

### Backend modules

```mermaid
flowchart TB
    main["main.py<br/>FastAPI routes"]

    subgraph agents["app/agents"]
        orch["orchestrator.py<br/>chat agent loop"]
        tools["tools.py<br/>agent tools"]
        docs["documents.py<br/>document agent"]
        llm["llm.py<br/>provider layer"]
        gl["guidelines.py<br/>freshness gate"]
        jr["journeys.py<br/>pathway · money · automation"]
        rules["rules.py<br/>dates · MRZ · fees · gap check"]
    end

    subgraph pipeline["app/pipeline"]
        prun["run.py"] --> fetch["fetch.py"]
        prun --> extract["extract.py"]
        prun --> verify["verify.py"]
        targets["targets.py"] --> prun
    end

    explore["explore.py<br/>visa decisions"]
    forms["forms/<br/>prefill · PDF"]
    worker["worker.py"]

    main --> orch --> tools
    orch --> llm
    tools --> gl & jr & rules & explore & forms
    jr --> rules & gl
    main --> jr & explore & forms
    worker --> docs --> llm
    docs --> rules
    worker --> prun
    extract --> llm
    prun --> gl
    explore --> gl
```

---

## Core principle: the model talks, code decides

The language model never decides anything with legal or numeric weight. It converses, picks tools
and reads documents into raw strings; deterministic code does the rest.

```mermaid
flowchart LR
    subgraph model["🤖 Model decides"]
        m1["What to say"]
        m2["Which tool to call"]
        m3["Raw text read from a document"]
        m4["Facts proposed from official pages<br/>with a quote as evidence"]
    end
    subgraph code["⚙️ Code decides"]
        c1["Whether a guideline may be used<br/>freshness gate"]
        c2["Date parsing — ambiguous dates are reported, never guessed"]
        c3["Passport MRZ check digits"]
        c4["Document validity windows, minimum amounts"]
        c5["Fee totals in Decimal, per currency"]
        c6["Requirement gap: satisfied · problem · missing"]
        c7["Step due dates, form filling"]
        c8["Keeping a pipeline fact only if its quote<br/>and numbers are on the page"]
    end
    model -. "proposals only" .-> code
```

### Guideline freshness gate

Every immigration fact the assistant uses passes through `guidelines.find()`:

```mermaid
flowchart TD
    q["Lookup: destination · citizenship · purpose"] --> rows{"Entry for this citizenship,<br/>or for any citizenship '*'?"}
    rows -- no --> missing["missing"]
    rows -- yes --> ver{"Verified?"}
    ver -- no --> stale["stale"]
    ver -- yes --> age{"Verified within the limit?<br/>pipeline: 3 days · manual: 90 days"}
    age -- no --> stale
    age -- yes --> valid{"Past its valid_until?"}
    valid -- yes --> stale
    valid -- no --> current["✅ current"]
    current --> use["Tool returns requirements, fees,<br/>steps and forms with sources"]
    stale --> upd["Tool returns only 'not_up_to_date'<br/>→ assistant says the country is being updated"]
    missing --> upd
```

---

## Chat agent

`POST /api/chat/sessions/{id}/messages` streams the turn as Server-Sent Events: assistant text,
tool progress (`start` / `done` / `error`) and finally which data changed, so the UI refreshes
journeys, to-dos or forms without reloading.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as Frontend
    participant API as FastAPI
    participant O as Orchestrator
    participant M as LLM provider
    participant T as Tools
    participant DB as PostgreSQL

    U->>FE: "Russian passport, study in Hungary from 2027-02-01"
    FE->>API: POST message
    API->>API: rate limit · one turn per chat
    API->>O: run_turn
    O->>DB: load history + open journeys
    O->>DB: store user message + context (today, current journey)
    loop up to 10 steps
        O->>M: system prompt + history + tool definitions
        M-->>O: text and/or tool calls
        O-->>FE: SSE text chunks
        alt tool calls
            O-->>FE: SSE tool start
            O->>T: validate input (Pydantic) · run scoped to this user
            T->>DB: read / write
            T-->>O: result (+ link cards for the UI)
            O-->>FE: SSE tool done + journey/form cards
            O->>DB: store assistant step + tool results
        else no tool calls
            O->>DB: store final reply
        end
    end
    O-->>FE: SSE done {changed: journeys, tasks, …}
    FE->>FE: refresh affected pages
```

### Agent tools

```mermaid
flowchart LR
    agent(("Chat<br/>agent"))

    subgraph read["Read"]
        get_my_case
        list_supported_destinations
        get_country_guidelines
        check_my_documents
        list_my_journeys
        get_journey
        find_destinations
    end

    subgraph plan["Plan"]
        create_journey
        create_journeys["create_journeys<br/>compare up to 5"]
        switch_journey
        update_journey
        set_step_done
    end

    subgraph act["Act"]
        add_todo["add_todo<br/>personal to-do list"]
        prefill_form
        update_my_profile
    end

    agent --> read & plan & act
```

| Tool | What it does |
| --- | --- |
| `get_my_case` | Profile, analysed documents, journeys with progress, personal to-dos |
| `get_country_guidelines` | Verified requirements, fees, steps and forms (only when current) |
| `check_my_documents` | Gap check of the user's documents against a trip's requirements |
| `create_journey` / `create_journeys` | Build one journey, or several to compare side by side |
| `switch_journey` / `get_journey` / `list_my_journeys` | Move between and inspect the user's journeys |
| `update_journey` | Status, travel date, stay length (due dates are recomputed), summary |
| `set_step_done` | Tick a pathway step |
| `add_todo` | Add an item to the personal to-do list, optionally with a due date |
| `prefill_form` | Fill an application form from passport, profile and journey |
| `find_destinations` | Easiest destinations for the passport, or alternatives near a hard one |
| `update_my_profile` | Save citizenship, address, status, studies |

### LLM provider layer

```mermaid
flowchart TD
    p{"LLM_PROVIDER"}
    p -- gemini --> g["Gemini<br/>GEMINI_MODEL<br/>+ quota fallback models"]
    p -- anthropic --> a["Claude<br/>ANTHROPIC_MODEL · adaptive thinking<br/>prompt caching · refusal fallback"]
    p -- local --> l["OpenAI-compatible server<br/>LM Studio · llama.cpp · Ollama"]
    p -- unset --> auto{"GEMINI_API_KEY set?"}
    auto -- yes --> g
    auto -- no --> a
    l --> lc["Chat: LOCAL_LLM_CHAT_MODEL<br/>needs reliable tool calling"]
    l --> ld["Documents + pipeline: LOCAL_LLM_MODEL<br/>vision model for scans"]
```

---

## Journeys

A journey is the user's plan for one trip or move. It is created from a **current** guideline and
stores a pathway of tasks; everything else is computed live by `journeys.view()` on every read, so
the chat and the UI always agree.

```mermaid
flowchart TD
    start["create_journey<br/>destination · citizenship · purpose<br/>travel date · stay length"] --> gate{"Guideline current?"}
    gate -- no --> nu["'Being updated' — nothing created"]
    gate -- yes --> dup{"Open journey for same<br/>destination + purpose?"}
    dup -- "yes, not confirmed" --> exists["Return existing journey<br/>→ switch_journey"]
    dup -- "no / allow_duplicate / next leg" --> create["Journey row<br/>pinned to guideline version"]
    create --> path["Pathway tasks<br/>1. requirement: each document to get<br/>2. step: each application step"]
    path --> due["Due dates = travel date − days_before_travel"]
    due --> focus["Chat now works on this journey"]

    subgraph live["Computed on every read"]
        v1["Requirement gap<br/>satisfied · problem · missing"]
        v2["Finances<br/>mandatory fee totals · paid · upcoming · budget"]
        v3["Automation<br/>prefill forms · pay fees · calendar .ics · document requests"]
        v4["Progress<br/>done / total steps"]
    end
    focus --> live
```

```mermaid
stateDiagram-v2
    [*] --> planning: create_journey
    planning --> active: user starts
    active --> completed: all done
    completed --> active: reopen for more help
    planning --> archived
    active --> archived
    completed --> archived
    completed --> [*]: next leg →<br/>new journey with continues_journey_id
```

### To-do list

```mermaid
flowchart LR
    subgraph tasks["tasks table"]
        personal["kind = personal<br/>journey_id = null<br/>source: user or agent"]
        req["kind = requirement<br/>a document to get"]
        step["kind = step<br/>an application step"]
    end
    todoPage["To-do page<br/>POST /api/tasks"] --> personal
    chat["Chat: add_todo"] --> personal
    cj["create_journey"] --> req & step
    upd["update_journey<br/>new travel date"] -- "reschedule open tasks" --> req & step
    sd["set_step_done"] --> step
    req & step --> ics["calendar.ics export"]
```

---

## Document analysis

```mermaid
flowchart TD
    up["User uploads a file<br/>POST /api/documents"] --> s3[("RustFS")]
    up --> row["document_analyses row<br/>status = pending"]
    row --> claim["Worker claims it<br/>every 3 s · retried after 10 min"]
    claim --> kind{"File type"}
    kind -- "PDF with text layer" --> txt["Send text<br/>MRZ taken from text by code"]
    kind -- "image / scanned PDF" --> img["Send page images<br/>needs a vision model"]
    txt & img --> llm["Model reads into a fixed schema<br/>values exactly as printed"]
    llm --> norm["rules.normalize_extraction<br/>• dates parsed, ambiguity flagged<br/>• MRZ check digits verified<br/>• expiry and validity issues"]
    norm --> done["status = done<br/>normalised fields + issues"]
    done --> usedby["Used by: requirement gap check ·<br/>form prefill · get_my_case"]
```

---

## Guidelines pipeline

Runs daily at `PIPELINE_HOUR_UTC` (and on demand from the admin **Data sources** page). Each target
is one `(destination, citizenship, purpose)` with seed URLs on allowlisted official domains.

```mermaid
flowchart TD
    cron["Daily at 03:00 UTC<br/>or admin-queued run"] --> lock{"Postgres advisory lock"}
    lock -- "held elsewhere" --> skip["Skip"]
    lock -- acquired --> each["For each target"]
    each --> disc["Discover more official pages<br/>Gemini + Google Search, allowlist only"]
    disc --> fetch["Fetch pages · snapshot + content hash"]
    fetch --> same{"Sources unchanged and<br/>every stored quote still on its page?"}
    same -- yes --> rever["Re-verify: bump verified_at<br/>no model call"]
    same -- no --> ext["Model extracts a guideline<br/>every fact with url + quote"]
    ext --> ver["verify.py — deterministic<br/>• quote found on that page today<br/>• every number appears in the quote<br/>• ≥ 3 requirements<br/>• loses ≤ 40% vs previous version"]
    ver --> dec{"Passes?"}
    dec -- yes --> pub["Publish new version"]
    dec -- no --> hold["Hold · keep previous entry"]
    hold --> expire["Previous entry stops being used<br/>after 3 days without verification"]
```

---

## Explore map

`explore.py` decides each destination's status for one passport, residence permit and purpose,
and records which source decided it — strongest first:

```mermaid
flowchart TD
    c["Destination country"] --> h{"Own country or<br/>residence-permit country?"}
    h -- yes --> home["home"]
    h -- no --> r{"EU/EEA/Swiss free movement, or<br/>Schengen permit for a short Schengen trip?"}
    r -- yes --> rule["rule"]
    r -- no --> v{"Current Unbound guideline<br/>with an entry type?"}
    v -- yes --> verified["verified ✅"]
    v -- no --> i{"Open Passport Index<br/>visa matrix (tourism)?"}
    i -- yes --> ind["indicative ⚠️<br/>labelled with dataset date"]
    i -- no --> none["unknown"]
```

The map ranks visa-free first, then visa on arrival, then eVisa, and suggests easier alternatives
near a country that is hard to enter. The chat uses the same logic via `find_destinations`.

---

## Data model

```mermaid
erDiagram
    users ||--o{ journeys : plans
    users ||--o{ tasks : has
    users ||--o{ documents : uploads
    users ||--o{ payments : makes
    users ||--o{ notifications : receives
    users ||--o{ chat_sessions : chats
    users ||--o{ prefilled_forms : owns
    users ||--o{ favorite_destinations : saves
    documents ||--o| document_analyses : "analysed as"
    journeys ||--o{ tasks : "pathway steps"
    journeys ||--o{ payments : fees
    journeys ||--o{ prefilled_forms : forms
    journeys |o--o{ journeys : "next leg"
    journeys }o--|| country_guidelines : "built from"
    chat_sessions }o--o| journeys : "about"
    chat_sessions ||--o{ chat_messages : contains
    pipeline_runs ||--o{ source_snapshots : fetched

    journeys {
        string destination_code
        string origin_code
        string purpose
        string status
        date travel_date
        int stay_days
        int guideline_version
    }
    tasks {
        string kind "personal | requirement | step"
        string title
        date due_date
        bool done
        string source "user | agent"
    }
    country_guidelines {
        string destination_code
        string origin_code "ISO2 or *"
        string purpose
        json requirements
        json fees
        json steps
        json forms
        datetime verified_at
        string managed_by "pipeline | manual"
    }
    document_analyses {
        string status "pending | done | failed | skipped"
        json normalized
        json issues
    }
```

---

## Run locally

Requirements: Docker (Compose v2) and Node.js 22+ (`nvm use` reads `.nvmrc`).

```bash
npm run setup     # creates .env from .env.example, generates JWT_SECRET, installs frontend deps
```

Then fill in `.env`: `GOOGLE_CLIENT_ID` (OAuth "Web application" client, authorised origin
`http://localhost:5173`) and an AI provider (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or a local model:
see [backend/README.md](backend/README.md)). `.env` is the only env file you edit: compose passes it
to the containers and `frontend/vite.config.ts` reads `GOOGLE_CLIENT_ID` from it.

```bash
npm run dev         # Postgres, storage, API on :8000 and worker in Docker; frontend locally on :5173
npm run docker:up   # or everything in Docker, frontend included (hot reload)
```

The app must be on port 5173 (the origin the API allows), so don't run both at once. After changing
`.env`, run the command again to recreate the containers. Add your Google account to `ADMIN_EMAILS`
in `.env` to see **Data sources** (the pipeline) in the app.

**Local model (LM Studio):** set `LLM_PROVIDER=local`, load the models, and start the server where
the containers can reach it: `~/.lmstudio/bin/lms server start --port 1234 --bind 172.17.0.1`. Use a
model with reliable tool calling for chat (`LOCAL_LLM_CHAT_MODEL`, e.g. `qwen3-4b-instruct-2507`) and
a vision model for scanned documents (`LOCAL_LLM_MODEL`, e.g. `qwen2.5-vl-7b-instruct`).

| Service | URL |
| --- | --- |
| App | http://localhost:5173 |
| API / docs | http://localhost:8000 · http://localhost:8000/docs |
| RustFS console | http://localhost:9001 (`minioadmin` / `minioadmin`) |
| Postgres | `localhost:5432`, `unbound_user` / `unbound_password`, db `unbound_db` |

| Command | What it does |
| --- | --- |
| `npm run setup` | Create `.env`, install frontend deps |
| `npm run dev` | Backend stack in Docker + local Vite dev server |
| `npm run docker:up` / `docker:down` | Start / stop everything |
| `npm run docker:reset` | Stop and **delete** the database and storage volumes |
| `npm run docker:logs` | Follow backend and worker logs |
| `npm test` | Backend tests (pytest, in the running backend container) |
| `npm run lint` / `npm run build` | Frontend lint / production build |
| `npm run check` | Lint, build and test |
| `npm run guidelines:import` | Load `backend/data/guidelines/` into the database |
| `npm run models:list` | Gemini models your key can use |

## Run the production stack locally

The same images and setup as production (built frontend behind nginx, backend without reload,
worker with the daily pipeline), on `http://localhost:8080`, without a domain or HTTPS:

```bash
./scripts/local-prod.sh up       # first run generates .env.prod.local with local-only secrets
./scripts/local-prod.sh logs     # backend + worker logs
./scripts/local-prod.sh down     # stop, keep data
./scripts/local-prod.sh reset    # stop and delete its data
```

It uses your `.env` keys but its own database and storage (project `unbound-local`), so it can run
next to the dev stack. Add `http://localhost:8080` to the Google OAuth client's authorised
JavaScript origins. Set `LOCAL_PORT` to use another port, and `PIPELINE_ENABLED=false` in `.env` to
keep it from spending AI quota on the daily pipeline.

## Deploy (one server)

```mermaid
flowchart LR
    net(["Internet<br/>:80 / :443"]) --> caddy["caddy"] --> fe["frontend<br/>nginx"]
    fe -- "/api" --> be["backend"]
    be --> pg[("postgres")]
    be --> st[("storage")]
    wk["worker"] --> pg & st
```

1. Point a domain at the server. In the Google OAuth client, add `https://<domain>` as an authorised JavaScript origin.
2. Fill the production part of `.env` (`DOMAIN`, `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) plus the keys above.
3. `docker compose -f docker-compose.prod.yml up -d --build`

Caddy gets HTTPS certificates automatically; only ports 80 and 443 are exposed. The worker runs the guidelines pipeline daily at `PIPELINE_HOUR_UTC` (default 03:00 UTC).

**AI quota:** a daily pipeline run plus chat needs a paid Gemini key (the free tier allows about 20 requests per model per day), an Anthropic key with credits, or a local model in LM Studio (`LLM_PROVIDER=local`, see [backend/README.md](backend/README.md)).

## Tests

```bash
npm test          # or: docker exec -w /app unbound_backend python -m pytest -q tests/
```

More detail: [backend/README.md](backend/README.md), [frontend/README.md](frontend/README.md).
