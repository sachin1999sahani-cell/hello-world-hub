"""Run poller scheduler + API server in one process."""
import logging

import uvicorn

import db
from poller import build_scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("serve")


def main():
    db.init_db()
    sched = build_scheduler()
    sched.start()
    log.info("scheduler started with %d jobs", len(sched.get_jobs()))
    uvicorn.run("app:app", host="0.0.0.0", port=8600, log_level="info")


if __name__ == "__main__":
    main()
