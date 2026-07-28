# mav-rag ingest — estimates support

**mav-rag is not under version control on the AIWA host.** `/opt/mav-rag/` is a
plain directory on the Proxmox host with no git repository behind it. This
folder is the only record of what that service runs, and the only rollback
reference. Treat it accordingly.

| File | Role |
|---|---|
| `main.py.snapshot-20260728` | Byte-exact copy of `/opt/mav-rag/ingest/main.py` as deployed on 2026-07-28. **Never edit.** sha256 `fd9054ae5bb11730e066da35f4e0e03088aedce3014b1998d6978422787c21e3` |
| `main.py` | The snapshot plus the estimates change below. This is what gets deployed. |

## What changed and why

The weekly HCP catalog sync (`sync-catalog`) publishes a new `estimates.csv`
into the RAG ingest directory. Before this change the ingest had no idea what
that file was: `detect_type()` would have seen `customer_name` and fallen
through to `"customer"`, filing 948 estimate rows as customers.

Three edits, nothing else:

1. **`detect_type()` gains an estimate branch** returning `"estimate"` when
   `estimate_uuid` is in the header. It is deliberately checked **before** the
   job branch. The estimates export also carries a customer name and a total, so
   if a future column change let it match the job branch first, the weekly jobs
   sync — which deletes every point with `type == "job"` — would destroy the
   estimates on its next run.
2. **`estimate_row_to_text()` + `process_estimates_csv()`** — a processor modeled
   on the existing job path: same `grizzly_hcp` collection, same embedding call,
   same batched upsert, same logging. The payload `type` is exactly `"estimate"`.
   Point IDs are derived from `option_uuid` (falling back to `estimate_uuid` for
   estimates that have no options), so re-ingesting the weekly export overwrites
   rows in place instead of duplicating them.
3. **Dispatch wiring** in `process_csv()` routes `"estimate"` to the new
   processor. Archiving to `/data/processed` is unchanged — it happens in
   `handle_hcp_file()`, after `process_csv()` returns.

No `delete` call was added anywhere. Every ingest path remains upsert-only.

## Apply

> The image is **built** from source (`build: ./ingest` in
> `/opt/mav-rag/docker-compose.yml`), so `main.py` is baked into the image at
> build time — it is not bind-mounted. **`docker restart mav-rag-ingest` will
> silently keep running the old code.** The container must be rebuilt.

Everything below runs on the AIWA host through Orca. Restarting or rebuilding a
container is a live-state change and needs Carter's explicit approval first.

1. Transfer the reviewed `main.py` to the host through the Orca terminal and
   confirm it arrived intact before touching `/opt`:

   ```
   sha256sum /root/agent-work/main.py
   ```

   It must match the sha256 of `deploy/mav-rag/main.py` in this repo. If it does
   not, stop — do not copy a partial file over a working ingest.

2. Confirm the file currently in place is the one the snapshot records, so you
   know exactly what you are replacing:

   ```
   sha256sum /opt/mav-rag/ingest/main.py
   ```

   Expect `fd9054ae5bb11730e066da35f4e0e03088aedce3014b1998d6978422787c21e3`.
   A different hash means the host drifted from this repo — investigate and
   re-snapshot before proceeding.

3. Keep a local rollback copy on the host, then install:

   ```
   cp /opt/mav-rag/ingest/main.py /opt/mav-rag/ingest/main.py.bak-20260728
   cp /root/agent-work/main.py /opt/mav-rag/ingest/main.py
   ```

4. Rebuild and bring the ingest up (**approval required**):

   ```
   cd /opt/mav-rag && docker compose build ingest && docker compose up -d ingest
   ```

## Verify

1. The container is running the new code:

   ```
   docker exec mav-rag-ingest sha256sum /app/main.py
   ```

   It must match the sha256 of `deploy/mav-rag/main.py` in this repo. The
   Dockerfile does `WORKDIR /app` + `COPY main.py .`, so that path is the code
   the container actually executes. A hash matching the *snapshot* instead means
   the rebuild did not take.

2. Drop an estimates CSV into the ingest directory and watch it classify:

   ```
   docker logs --tail 20 mav-rag-ingest
   ```

   Expect a line of the form
   `Processing estimates CSV estimates.csv (N rows)` followed by
   `Upserted N estimate options from estimates.csv (skipped 0)`.
   If you see `Processing estimates.csv as customer` instead, the estimate branch
   is not live — the rebuild did not take.

3. The points landed with the right type and did not disturb the jobs:

   ```
   curl -s http://localhost:6333/collections/grizzly_hcp/points/count \
     -H 'Content-Type: application/json' \
     -d '{"filter":{"must":[{"key":"type","match":{"value":"estimate"}}]}}'
   ```

   Repeat with `"job"` and confirm that count is unchanged from before the run.

## Rollback

The snapshot is the exact previously-deployed version. To revert:

```
cp /opt/mav-rag/ingest/main.py.bak-20260728 /opt/mav-rag/ingest/main.py
sha256sum /opt/mav-rag/ingest/main.py
cd /opt/mav-rag && docker compose build ingest && docker compose up -d ingest
```

The hash must read
`fd9054ae5bb11730e066da35f4e0e03088aedce3014b1998d6978422787c21e3`. If the
on-host backup is missing, `main.py.snapshot-20260728` in this repo is the same
bytes and can be transferred back the same way.

Rolling back leaves any already-ingested `type: "estimate"` points in Qdrant.
They are inert — nothing else reads or deletes that type — so they can be left
in place, or removed with a filtered delete on `type == "estimate"` if a clean
slate is wanted.
