import os

# Importing app.server starts the graph-index worker and runs the backfill
# sweep at import time (same convention as jobs.start_worker and the
# startup sweeps). In tests that would enqueue REAL sessions from the dev
# machine's store and start REAL Ollama extraction calls in the
# background. This env var (checked in server.py) disables the worker
# start + backfill for the whole test process; the enqueue hook itself
# stays active and harmless (a queued id with no worker is inert).
os.environ.setdefault("GRAPH_INDEXING_DISABLED", "1")
